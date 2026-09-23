import AppKit
import SwiftUI

private let islandBezel = Color(red: 0.004, green: 0.005, blue: 0.007)

private struct RouterReduceMotionKey: EnvironmentKey {
  static let defaultValue = false
}

private extension EnvironmentValues {
  var routerReduceMotion: Bool {
    get { self[RouterReduceMotionKey.self] }
    set { self[RouterReduceMotionKey.self] = newValue }
  }
}

private struct IslandActivitySession: Identifiable {
  let id: String
  let name: String
  let requests: [RouterActiveRequest]

  var agents: [RouterActiveRequest] {
    var seen = Set<String>()
    return requests.filter { request in
      seen.insert(request.threadId ?? request.id).inserted
    }
  }

  var latestStartedAt: Double {
    requests.map(\.startedAt).max() ?? 0
  }
}

@MainActor
final class IslandDisplayModel: ObservableObject {
  enum State: Equatable {
    case compact
    case peek
    case expanded
  }

  @Published private(set) var state: State = .compact
  @Published private(set) var activeRequestCount = 0
  @Published private(set) var accountRowCount = 0

  var size: CGSize {
    // The per-account quota table grows the island rather than being clipped by
    // it: a row the user cannot see is worse than a taller island.
    let quotaHeight = IslandAccountQuotaPresentation.tableHeight(rows: accountRowCount)
    switch state {
    case .compact: return CGSize(width: 320, height: 40)
    case .peek:
      if activeRequestCount > 0 {
        return CGSize(
          width: 404,
          height: min(430, 126 + CGFloat(activeRequestCount) * 40 + quotaHeight + 8)
        )
      }
      return CGSize(width: 404, height: min(430, 148 + quotaHeight + 8))
    case .expanded:
      return CGSize(width: 520, height: min(500, 372 + quotaHeight + 8))
    }
  }

  func setState(_ next: State) {
    guard state != next else { return }
    state = next
  }

  func setActiveRequestCount(_ count: Int) {
    activeRequestCount = max(0, count)
  }

  func setAccountRowCount(_ count: Int) {
    accountRowCount = max(0, count)
  }
}

@MainActor
final class IslandWindowController {
  // Tall enough for the tallest state the island can reach, which the restored
  // per-account quota table raises. The panel is transparent and top-anchored,
  // so the unused remainder costs nothing and a short window would clip rows.
  static let windowSize = CGSize(width: 720, height: 560)

  private let window: NSPanel
  private let store: RouterStore
  private let display = IslandDisplayModel()
  private var globalMouseMonitor: Any?
  private var localMouseMonitor: Any?
  private var initialTrackingTimer: Timer?
  private var screenObserver: NSObjectProtocol?
  private var trackingInstalled = false
  private let ownsOverlay: Bool

  // Only one process may draw the overlay. Nothing else enforces this, and two
  // aggravators made duplicate overlays easy to hit: a stale bundle at another
  // path can launch alongside the installed app, and a `swift run` debug binary
  // has no bundle identifier at all -- so it reads a different UserDefaults
  // domain and can never observe a preference set by the installed app. A user
  // who turned the Island off then watched an overlay stay on screen was
  // looking at that second process. Suppress the unbundled build outright, and
  // yield to an installed tray that is already running.
  private static func claimsOverlay() -> Bool {
    guard let identifier = Bundle.main.bundleIdentifier else { return false }
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
      .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    return others.isEmpty
  }

  init(store: RouterStore) {
    self.store = store
    ownsOverlay = Self.claimsOverlay()
    window = NSPanel(
      contentRect: NSRect(origin: .zero, size: Self.windowSize),
      styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.level = .popUpMenu
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    window.isMovable = false
    window.hidesOnDeactivate = false
    window.contentView = nil
  }

  func setVisible(_ visible: Bool) {
    // A process that does not own the overlay still tears down on `false`, so a
    // window it somehow put up can never outlive the setting.
    if visible && ownsOverlay {
      installContentIfNeeded()
      reposition()
      window.orderFrontRegardless()
      if !trackingInstalled {
        installMouseTracking()
        trackingInstalled = true
      }
      if screenObserver == nil {
        screenObserver = NotificationCenter.default.addObserver(
          forName: NSApplication.didChangeScreenParametersNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in
          Task { @MainActor in self?.reposition() }
        }
      }
    } else {
      window.orderOut(nil)
      window.contentView = nil
      removeMouseTracking()
      removeScreenObserver()
    }
  }

  deinit {
    if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
    if let localMouseMonitor { NSEvent.removeMonitor(localMouseMonitor) }
    if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
    initialTrackingTimer?.invalidate()
  }

  private func installContentIfNeeded() {
    guard window.contentView == nil else { return }
    window.contentView = NSHostingView(
      rootView: IslandOverlayView(store: store, display: display)
        .frame(width: Self.windowSize.width, height: Self.windowSize.height, alignment: .top)
        .preferredColorScheme(.dark)
        .environment(\.routerReduceMotion, true)
    )
  }

  private func removeMouseTracking() {
    if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
    if let localMouseMonitor { NSEvent.removeMonitor(localMouseMonitor) }
    globalMouseMonitor = nil
    localMouseMonitor = nil
    initialTrackingTimer?.invalidate()
    initialTrackingTimer = nil
    trackingInstalled = false
  }

  private func removeScreenObserver() {
    if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
    screenObserver = nil
  }

  private func reposition() {
    guard let screen = screenUnderPointer() ?? NSScreen.main else { return }
    let frame = screen.frame
    window.setFrame(
      NSRect(
        x: frame.midX - Self.windowSize.width / 2,
        y: frame.maxY - Self.windowSize.height,
        width: Self.windowSize.width,
        height: Self.windowSize.height
      ),
      display: true
    )
  }

  private func installMouseTracking() {
    window.ignoresMouseEvents = true
    let handler: (NSEvent) -> Void = { [weak self] _ in
      Task { @MainActor in
        self?.initialTrackingTimer?.invalidate()
        self?.initialTrackingTimer = nil
        self?.updateMouseState()
      }
    }
    globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: handler)
    localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { event in
      handler(event)
      return event
    }
    initialTrackingTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.updateMouseState() }
    }
  }

  private func updateMouseState() {
    let cursor = NSEvent.mouseLocation
    let frame = window.frame
    let resetDialogOpen = store.chatGptResetCreditPrompt != nil
      || store.chatGptResetCreditFeedback != nil
    if resetDialogOpen, display.state != .expanded { display.setState(.expanded) }
    let visible = display.size
    let islandRect = NSRect(
      x: frame.midX - visible.width / 2,
      y: frame.maxY - visible.height,
      width: visible.width,
      height: visible.height
    )
    let inside = islandRect.contains(cursor)
    window.ignoresMouseEvents = !inside
    // The pointer leaves the Island to reach other UI. Keep an in-progress
    // credit confirmation visible until the user explicitly resolves it.
    if resetDialogOpen { return }
    if inside, display.state == .compact {
      display.setState(.peek)
      store.setIslandInspecting(true)
      Task { [store] in
        await store.refreshNativeUsageIfStale(maxAge: 5.0)
      }
    } else if !inside, display.state != .compact {
      display.setState(.compact)
      store.setIslandInspecting(false)
    }
  }

  private func screenUnderPointer() -> NSScreen? {
    let pointer = NSEvent.mouseLocation
    return NSScreen.screens.first(where: { $0.frame.contains(pointer) })
  }
}

private struct IslandOverlayView: View {
  @Environment(\.routerReduceMotion) private var reduceMotion
  @ObservedObject var store: RouterStore
  @ObservedObject var display: IslandDisplayModel
  @State private var selectedSessionID: String?

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        IslandSilhouette()
          .fill(islandBezel.opacity(0.998))
          .overlay {
            IslandSilhouette()
              .fill(
                LinearGradient(
                  colors: [Color.white.opacity(0.018), .clear, Color.white.opacity(0.008)],
                  startPoint: .topLeading,
                  endPoint: .bottomTrailing
                )
              )
          }
        glow
        content
        if store.chatGptResetCreditPrompt != nil || store.chatGptResetCreditFeedback != nil {
          resetCreditDialog
            .zIndex(20)
        }
      }
      .frame(width: display.size.width, height: display.size.height)
      .contentShape(IslandSilhouette())
      .onTapGesture {
        if display.state != .expanded {
          display.setState(.expanded)
          store.setIslandInspecting(true)
          Task {
            await store.refreshNativeUsageIfStale(maxAge: 3.0)
          }
        }
      }
      .animation(
        reduceMotion ? nil : .spring(response: 0.42, dampingFraction: 0.82),
        value: display.state
      )
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .foregroundStyle(.white)
    .onAppear {
      display.setActiveRequestCount(activeSessions.count)
      display.setAccountRowCount(store.chatGptAccountUsage?.accounts.count ?? 0)
    }
    .onChange(of: store.activeRequests.count) { count in
      display.setActiveRequestCount(activeSessions.count)
      if count == 0 { selectedSessionID = nil }
    }
    .onChange(of: store.chatGptAccountUsage?.accounts.count) { count in
      display.setAccountRowCount(count ?? 0)
    }
    .onChange(of: store.chatGptResetCreditPrompt?.accountId) { accountId in
      if accountId != nil {
        display.setState(.expanded)
        store.setIslandInspecting(true)
      }
    }
  }

  private var resetCreditDialog: some View {
    ZStack {
      islandBezel.opacity(0.84)
        .contentShape(Rectangle())
      VStack(alignment: .leading, spacing: 11) {
        if let prompt = store.chatGptResetCreditPrompt {
          Text(routerLocalized("Use this banked reset?"))
            .font(.system(size: 16, weight: .bold, design: .rounded))
          Text(prompt.accountLabel)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .foregroundStyle(.white.opacity(0.9))
            .lineLimit(2)
            .truncationMode(.middle)
          Text(routerLocalized("A reset is available near a rate limit (at least 90% used). It immediately resets this account's usage limits, spends one banked reset credit, and cannot be undone."))
            .font(.system(size: 11))
            .foregroundStyle(.white.opacity(0.75))
            .fixedSize(horizontal: false, vertical: true)
          HStack {
            Text(routerFormat("%d available", prompt.availableCount))
              .font(.system(size: 10, weight: .medium))
              .foregroundStyle(routerMuted)
            Spacer()
            Button(routerLocalized("Cancel")) { store.cancelChatGptResetCredit() }
              .disabled(store.chatGptAccountOperation != nil)
            Button(routerLocalized("Use reset credit")) {
              Task { await store.confirmChatGptResetCredit() }
            }
            .disabled(store.chatGptAccountOperation != nil)
          }
          .buttonStyle(.bordered)
          .font(.system(size: 11, weight: .semibold))
        } else if let feedback = store.chatGptResetCreditFeedback {
          Text(resetCreditFeedbackTitle(feedback.status))
            .font(.system(size: 15, weight: .bold, design: .rounded))
            .foregroundStyle(feedback.status == .redeemed ? routerMint : routerYellow)
          Text(feedback.text)
            .font(.system(size: 11))
            .fixedSize(horizontal: false, vertical: true)
          HStack {
            Spacer()
            if feedback.status == .uncertain && feedback.canRetry {
              Button(routerLocalized("Retry saved attempt")) {
                Task { await store.retryUncertainChatGptResetCredit() }
              }
              .disabled(store.chatGptAccountOperation != nil)
              .buttonStyle(.bordered)
            }
            Button(routerLocalized("Done")) { store.dismissChatGptResetCreditFeedback() }
              .disabled(store.chatGptAccountOperation != nil)
              .buttonStyle(.bordered)
          }
        }
      }
      .padding(16)
      .frame(width: 350)
      .background(
        RoundedRectangle(cornerRadius: 15, style: .continuous)
          .fill(Color(red: 0.075, green: 0.085, blue: 0.105))
          .overlay {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
              .stroke(Color.white.opacity(0.18), lineWidth: 1)
          }
      )
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .clipShape(IslandSilhouette())
    .accessibilityElement(children: .contain)
  }

  private func resetCreditFeedbackTitle(_ status: ChatGptResetCreditStatus) -> String {
    switch status {
    case .redeemed: return routerLocalized("Reset credit used")
    case .notRedeemed: return routerLocalized("Reset credit was not used")
    case .uncertain: return routerLocalized("Reset credit status unknown")
    }
  }

  @ViewBuilder
  private var content: some View {
    switch display.state {
    case .compact:
      compactContent
        .transition(.opacity)
    case .peek:
      peekContent
        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
    case .expanded:
      expandedContent
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
  }

  private var compactContent: some View {
    HStack(spacing: 7) {
      LiveOrb(state: store.activityState)
      Text(store.activityState.label)
        .font(.system(size: 10, weight: .semibold, design: .rounded))
        .foregroundStyle(store.activityState.tint)
        .fixedSize()
      Text("·")
        .foregroundStyle(routerMuted)
        .fixedSize()
      ProviderIcon(providerID: compactProviderID, size: 18)
      BouncingSessionName(text: compactSessionName, fontSize: 10.5, weight: .medium)
        .frame(maxWidth: .infinity)
        .layoutPriority(1)
      if !store.activeRequests.isEmpty {
        Label("\(activeSessions.count)", systemImage: "bubble.left.and.bubble.right.fill")
          .font(.system(size: 9.5, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.72))
          .fixedSize()
          .help(RouterLanguage.isSimplifiedChinese
            ? "\(activeSessions.count) 个会话运行中"
            : "\(activeSessions.count) running \(activeSessions.count == 1 ? "chat" : "chats")")
      }
      if store.activeRequests.isEmpty {
        Text(compactUsageSummary)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(.white.opacity(0.78))
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
      if let weeklyRemainingPercent {
        VStack(alignment: .trailing, spacing: 0) {
          Text("\(Int(weeklyRemainingPercent.rounded()))%")
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(.white.opacity(0.9))
            .monospacedDigit()
          Text(routerLocalized("WEEKLY LEFT"))
            .font(.system(size: 6.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(routerMuted)
        }
        .fixedSize()
      }
    }
    .padding(.horizontal, 14)
  }

  @ViewBuilder
  private var peekContent: some View {
    if store.activeRequests.isEmpty {
      usagePeekContent
    } else {
      activityPeekContent
    }
  }

  private var usagePeekContent: some View {
    VStack(spacing: 9) {
      HStack(spacing: 9) {
        LiveOrb(state: store.activityState, count: store.activeChatCount)
        VStack(alignment: .leading, spacing: 1) {
          Text(store.activityState.label)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .foregroundStyle(store.activityState.tint)
            .lineLimit(1)
          Text("\(peekTitle) · \(sourceLabel)")
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(routerMuted)
            .lineLimit(1)
        }
        Spacer()
        HStack(spacing: 12) {
          IslandHeaderMetric(value: todayTokenValue, label: "\(routerLocalized("TODAY TOKENS")) · UTC")
          if let accountHeaderValue {
            IslandHeaderMetric(value: accountHeaderValue, label: accountHeaderLabel)
          }
        }
      }
      IslandAccountQuotaTable(store: store)
      IslandUsageLineChart(points: dailyGraphPoints, tint: graphTint, showsAxis: false)
        .id("\(store.selectedUsageProviderID)-daily-peek")
        .frame(height: 43)
    }
    .padding(.horizontal, 15)
    .padding(.top, 10)
    .padding(.bottom, 8)
  }

  private var activityPeekContent: some View {
    VStack(spacing: 8) {
      HStack(spacing: 9) {
        LiveOrb(state: store.activityState)
        VStack(alignment: .leading, spacing: 1) {
          Text(store.activityState.label)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .foregroundStyle(store.activityState.tint)
          Text(RouterLanguage.isSimplifiedChinese
            ? "\(activeSessions.count) 个会话运行中"
            : "\(activeSessions.count) \(activeSessions.count == 1 ? "CHAT" : "CHATS") RUNNING")
            .font(.system(size: 8, weight: .semibold, design: .monospaced))
            .foregroundStyle(routerMuted)
        }
        Spacer()
        HStack(spacing: 12) {
          IslandHeaderMetric(value: todayTokenValue, label: "\(routerLocalized("TODAY TOKENS")) · UTC")
          if let accountHeaderValue {
            IslandHeaderMetric(value: accountHeaderValue, label: accountHeaderLabel)
          }
        }
      }
      ScrollView(.vertical) {
        IslandSessionList(sessions: activeSessions, compact: true)
      }
      .scrollIndicators(.hidden)
      .frame(maxHeight: CGFloat(max(1, activeSessions.count)) * 40)

      IslandAccountQuotaTable(store: store)

      HStack {
        Text(routerLocalized("DAILY USAGE"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .foregroundStyle(routerMuted)
        Spacer()
        Text(routerLocalized("LAST 7 DAYS"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .foregroundStyle(routerMuted)
      }

      IslandUsageLineChart(points: dailyGraphPoints, tint: graphTint, showsAxis: false)
        .id("\(store.selectedUsageProviderID)-daily-active-peek")
        .frame(height: 43)
    }
    .padding(.horizontal, 14)
    .padding(.top, 10)
    .padding(.bottom, 10)
  }

  private var expandedContent: some View {
    Group {
      if activeSessions.isEmpty {
        usageExpandedContent
      } else {
        sessionExpandedContent
      }
    }
  }

  private var usageExpandedContent: some View {
    VStack(spacing: 13) {
      HStack(spacing: 10) {
        LiveOrb(state: store.activityState, count: store.activeChatCount)
        VStack(alignment: .leading, spacing: 2) {
          Text(peekTitle)
            .font(.system(size: 15, weight: .semibold, design: .rounded))
          Text("\(store.activitySummaryLabel) · \(sourceLabel)")
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(store.activityState.tint)
        }
        Spacer()
        Button(routerLocalized("Collapse")) { display.setState(.peek) }
        .buttonStyle(.plain)
        .font(.system(size: 9, weight: .medium, design: .rounded))
        .foregroundStyle(routerMuted)
      }

      HStack(spacing: 8) {
        MetricTile(
          title: routerLocalized("TODAY'S TOKENS"),
          value: todayTokenValue,
          detail: tokenSourceDetail,
          tint: .white.opacity(0.88)
        )
        MetricTile(
          title: accountTileTitle,
          value: accountTileValue,
          detail: accountTileDetail,
          tint: routerAccent
        )
      }

      IslandAccountQuotaTable(store: store)

      HStack(alignment: .firstTextBaseline) {
        Text(routerLocalized("DAILY TOKEN TREND"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(routerMuted)
        Spacer()
        Text(routerLocalized("LAST 7 DAYS"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.6)
          .foregroundStyle(routerMuted)
      }

      IslandUsageLineChart(points: dailyGraphPoints, tint: graphTint)
        .id("\(store.selectedUsageProviderID)-daily-expanded")
        .frame(height: 78)

      HStack {
        Text(routerLocalized(store.hasConcurrentActivity ? "ACTIVE NOW" : "ACTIVE PROVIDER"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(routerMuted)
        Spacer()
        Text(store.hasConcurrentActivity
          ? (RouterLanguage.isSimplifiedChinese
            ? "\(store.activeChatCount) 个会话运行中"
            : "\(store.activeChatCount) chats running")
          : routerLocalized("Account and traffic are provider-scoped"))
          .font(.system(size: 9, design: .rounded))
          .foregroundStyle(routerMuted)
      }

      if store.hasConcurrentActivity {
        ActiveRequestList(store: store, limit: 4, compact: false)
      } else {
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text(store.selectedUsageProvider.displayName)
              .font(.system(size: 10, weight: .semibold, design: .rounded))
            Text(store.selectedUsageProvider.detail)
              .font(.system(size: 8, design: .rounded))
              .foregroundStyle(routerMuted)
          }
          Spacer()
          Text(routerLocalized(store.activityState == .generating ? "Live" : "Last used"))
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(store.activityState.tint)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }
    }
    .padding(.horizontal, 17)
    .padding(.top, 13)
    .padding(.bottom, 12)
  }

  private var sessionExpandedContent: some View {
    VStack(spacing: 12) {
      HStack(spacing: 10) {
        if selectedSession != nil {
          Button {
            selectedSessionID = nil
          } label: {
            Image(systemName: "chevron.left")
          }
          .buttonStyle(.plain)
          .foregroundStyle(routerMuted)
        }
        LiveOrb(state: store.activityState, count: activeSessions.count)
        VStack(alignment: .leading, spacing: 2) {
          Text(selectedSession?.name ?? routerLocalized("Running chats"))
            .font(.system(size: 15, weight: .semibold, design: .rounded))
            .lineLimit(1)
          Text(selectedSession == nil
            ? (RouterLanguage.isSimplifiedChinese
              ? "\(activeSessions.count) 个会话运行中"
              : "\(activeSessions.count) \(activeSessions.count == 1 ? "chat" : "chats") running")
            : (RouterLanguage.isSimplifiedChinese
              ? "\(selectedSession?.agents.count ?? 0) 个已分配智能体"
              : "\(selectedSession?.agents.count ?? 0) assigned agents"))
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(store.activityState.tint)
        }
        Spacer()
        if let weeklyRemainingPercent {
          IslandHeaderMetric(
            value: "\(Int(weeklyRemainingPercent.rounded()))%",
            label: routerLocalized("WEEKLY LEFT")
          )
        }
        Button(routerLocalized("Collapse")) { display.setState(.peek) }
          .buttonStyle(.plain)
          .font(.system(size: 9, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
      }

      Divider().overlay(Color.white.opacity(0.08))

      if let session = selectedSession {
        ScrollView(.vertical) {
          IslandAgentList(store: store, session: session)
        }
        .scrollIndicators(.hidden)
      } else {
        ScrollView(.vertical) {
          IslandSessionList(
            sessions: activeSessions,
            compact: false,
            onSelect: { selectedSessionID = $0 }
          )
        }
        .scrollIndicators(.hidden)
        .frame(maxHeight: 92)

        IslandAccountQuotaTable(store: store)
      }

      Spacer(minLength: 0)
    }
    .padding(.horizontal, 17)
    .padding(.top, 13)
    .padding(.bottom, 12)
  }

  private var glow: some View {
    StatusGlow(state: store.activityState)
      .id("\(store.activityState.rawValue)-\(store.activeChatCount)")
  }

  private var peekTitle: String {
    store.activeRequests.first.map(store.sessionName(for:))
      ?? store.activitySessionName
      ?? routerLocalized("Router overview")
  }

  private var compactProviderID: String {
    store.activeRequests.first?.provider ?? store.selectedUsageProviderID
  }

  private var compactSessionName: String {
    store.activeRequests.first.map(store.sessionName(for:))
      ?? store.activitySessionName
      ?? routerLocalized("Ready")
  }

  private var activeSessions: [IslandActivitySession] {
    let grouped = Dictionary(grouping: store.activeRequests) { request in
      request.sessionId ?? request.sessionName ?? "request-\(request.id)"
    }
    return grouped.map { id, requests in
      let fallback = requests.first.map(store.sessionName(for:)) ?? "Active session"
      let name = requests.compactMap(\.sessionName).first
        ?? (grouped.count == 1 ? store.activitySessionName : nil)
        ?? fallback
      return IslandActivitySession(id: id, name: name, requests: requests)
    }
    .sorted { $0.latestStartedAt > $1.latestStartedAt }
  }

  private var selectedSession: IslandActivitySession? {
    guard let selectedSessionID else { return nil }
    return activeSessions.first(where: { $0.id == selectedSessionID })
  }

  private var sourceLabel: String {
    let provider = store.selectedUsageProviderID
    if provider == "openai" {
      let label = routerLocalized("CHATGPT • NATIVE")
      guard store.dailyFallbackDays(days: 7) > 0 else { return label }
      return "\(label) + \(routerLocalized("LOCAL FALLBACK"))"
    }
    if provider == "grok-oauth" { return routerLocalized("XAI • OAUTH SESSION") }
    if provider == "grok-api" { return routerLocalized("XAI • METERED API") }
    if provider.hasSuffix("-api") || ["deepseek", "chutes", "orca"].contains(provider) {
      if RouterLanguage.isSimplifiedChinese { return "计量 API" }
      return "METERED API"
    }
    return routerLocalized("OAUTH ROUTE")
  }

  private var compactUsageSummary: String {
    RouterLanguage.isSimplifiedChinese ? "今天 \(todayTokenValue)" : "\(todayTokenValue) today"
  }

  private var todayTokenValue: String {
    compactTokenCount(store.selectedTodayTokens)
  }

  private var dailyGraphPoints: [DailyUsagePoint] {
    store.dailyUsage(days: 7)
  }

  private var graphTint: Color {
    routerAccent
  }

  private var quotaRemainingPercent: Double? {
    if store.selectedUsageUsesChatGPT {
      guard let remaining = store.accountUsage?.primary?.remainingPercent else { return nil }
      return Double(max(0, min(100, remaining)))
    }
    guard let metric = store.selectedAccountMetric else { return nil }
    return remainingQuotaPercent(metric)
  }

  private var weeklyRemainingPercent: Double? {
    if store.selectedUsageUsesChatGPT {
      let windows = [store.accountUsage?.primary, store.accountUsage?.secondary].compactMap { $0 }
      guard let weekly = windows.first(where: { $0.durationLabel == "Weekly limit" }) else {
        return nil
      }
      return Double(max(0, min(100, weekly.remainingPercent)))
    }
    guard let weekly = store.selectedProviderUsage?.account.metrics.first(where: {
      $0.kind == "quota" && standardizedLimitLabel($0.label) == "Weekly limit"
    }), let remaining = weekly.remainingPercent else {
      return nil
    }
    return max(0, min(100, remaining))
  }

  private var accountUsageLabel: String {
    if store.selectedUsageUsesChatGPT {
      return routerLocalized(store.accountUsage?.primary?.durationLabel ?? "ChatGPT limit")
    }
    if let metric = store.selectedAccountMetric {
      return metric.kind == "quota"
        ? routerLocalized(standardizedLimitLabel(metric.label))
        : metric.label
    }
    return routerLocalized("Usage limit")
  }

  private var accountHeaderValue: String? {
    if let weeklyRemainingPercent { return "\(Int(weeklyRemainingPercent.rounded()))%" }
    if let quotaRemainingPercent { return "\(Int(quotaRemainingPercent.rounded()))%" }
    guard let metric = store.selectedAccountMetric, metric.kind == "balance" else { return nil }
    return formattedAccountMetric(metric)
  }

  private var accountHeaderLabel: String {
    if weeklyRemainingPercent != nil { return routerLocalized("WEEKLY LEFT") }
    if quotaRemainingPercent != nil {
      let window = accountUsageLabel.replacingOccurrences(
        of: " limit",
        with: "",
        options: [.caseInsensitive]
      )
      return "\(window.uppercased()) LEFT"
    }
    return accountUsageLabel.uppercased()
  }

  private var accountTileTitle: String {
    accountUsageLabel.uppercased()
  }

  private var accountTileValue: String {
    if let quotaRemainingPercent { return "\(Int(quotaRemainingPercent.rounded()))% left" }
    if let metric = store.selectedAccountMetric, metric.kind == "balance" {
      return formattedAccountMetric(metric)
    }
    return "—"
  }

  private var accountTileDetail: String {
    if let reset = store.selectedUsageResetDate { return usageResetCaption(reset) }
    if let detail = store.selectedAccountMetric?.detail, !detail.isEmpty { return detail }
    return quotaRemainingPercent == nil
      ? routerLocalized("Not reported by provider")
      : routerLocalized("No reset reported")
  }

  private var tokenSourceDetail: String {
    guard store.selectedUsageUsesChatGPT else { return routerLocalized("Measured by this router") }
    if store.dailyFallbackDays(days: 7) > 0 {
      return routerLocalized("OpenAI account usage; missing dates use local router fallback")
    }
    return routerLocalized("ChatGPT account usage")
  }

}

private struct IslandHeaderMetric: View {
  let value: String
  let label: String

  var body: some View {
    VStack(alignment: .trailing, spacing: 1) {
      Text(value)
        .font(.system(size: 17, weight: .semibold, design: .rounded))
        .monospacedDigit()
      Text(label)
        .font(.system(size: 7, weight: .semibold, design: .monospaced))
        .tracking(0.7)
        .foregroundStyle(routerMuted)
        .lineLimit(1)
    }
  }
}

private struct IslandUsageLineChart: View {
  @Environment(\.routerReduceMotion) private var reduceMotion
  let points: [DailyUsagePoint]
  let tint: Color
  var showsAxis = true

  @State private var hoveredIndex: Int?
  @State private var revealProgress: CGFloat = 0

  var body: some View {
    GeometryReader { geometry in
      let axisHeight: CGFloat = showsAxis ? 14 : 0
      let plotHeight = max(1, geometry.size.height - axisHeight)
      let maximum = max(points.map(\.tokens).max() ?? 0, 1)
      let coordinates = chartCoordinates(
        width: geometry.size.width,
        height: plotHeight,
        maximum: maximum
      )
      let visibleProgress = reduceMotion ? 1 : revealProgress

      ZStack(alignment: .topLeading) {
        Path { path in
          let y = plotHeight * 0.5
          path.move(to: CGPoint(x: 0, y: y))
          path.addLine(to: CGPoint(x: geometry.size.width, y: y))
        }
        .stroke(Color.white.opacity(0.035), style: StrokeStyle(lineWidth: 0.45, dash: [2, 4]))

        if !coordinates.isEmpty {
          areaPath(coordinates, baseline: plotHeight - 2)
            .fill(
              LinearGradient(
                colors: [tint.opacity(0.10), tint.opacity(0.006)],
                startPoint: .top,
                endPoint: .bottom
              )
            )
            .opacity(Double(visibleProgress))

          linePath(coordinates)
            .trim(from: 0, to: visibleProgress)
            .stroke(
              tint.opacity(0.78),
              style: StrokeStyle(lineWidth: 1.25, lineCap: .round, lineJoin: .round)
            )

          ForEach(Array(points.enumerated()), id: \.element.id) { index, point in
            if point.isRouterFallback, coordinates.indices.contains(index) {
              Circle()
                .stroke(routerYellow, style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
                .frame(width: 7, height: 7)
                .position(coordinates[index])
            }
          }
        }

        if showsAxis {
          ForEach(Array(points.enumerated()), id: \.element.id) { index, point in
            if shouldLabel(index: index), coordinates.indices.contains(index) {
              Text(axisLabel(for: point))
                .font(.system(size: 7.5, weight: .medium, design: .rounded))
                .foregroundStyle(routerMuted)
                .fixedSize()
                .position(
                  x: min(
                    geometry.size.width - 10,
                    max(10, coordinates[index].x)
                  ),
                  y: plotHeight + 6
                )
            }
          }
        }

        if let hoveredIndex,
           points.indices.contains(hoveredIndex),
           coordinates.indices.contains(hoveredIndex) {
          let coordinate = coordinates[hoveredIndex]
          Path { path in
            path.move(to: CGPoint(x: coordinate.x, y: 2))
            path.addLine(to: CGPoint(x: coordinate.x, y: plotHeight - 2))
          }
          .stroke(Color.white.opacity(0.14), lineWidth: 0.5)

          Circle()
            .fill(tint)
            .frame(width: 6, height: 6)
            .overlay(Circle().stroke(Color.white.opacity(0.65), lineWidth: 0.7))
            .position(coordinate)

          Text(hoverText(for: points[hoveredIndex]))
            .font(.system(size: 8, weight: .medium, design: .monospaced))
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(routerInk.opacity(0.92), in: Capsule())
            .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 0.5))
            .fixedSize()
            .position(
              x: min(geometry.size.width - 66, max(66, coordinate.x)),
              y: 11
            )
        }
      }
      .contentShape(Rectangle())
      .onContinuousHover { phase in
        switch phase {
        case .active(let location):
          hoveredIndex = nearestIndex(to: location.x, width: geometry.size.width)
        case .ended:
          hoveredIndex = nil
        }
      }
    }
    .onAppear { animateReveal() }
    // Compare the Equatable points value, not a freshly mapped array allocated
    // on every body pass (which interacted poorly with store reads during layout).
    .onChange(of: points) { _ in animateReveal() }
    .onChange(of: reduceMotion) { _ in animateReveal() }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(routerLocalized("Daily token usage line chart"))
    .accessibilityValue("\(formattedTotalTokens) tokens over \(points.count) days")
  }

  private func animateReveal() {
    withAnimation(nil) { revealProgress = reduceMotion ? 1 : 0 }
    guard !reduceMotion else { return }
    Task { @MainActor in
      await Task<Never, Never>.yield()
      withAnimation(.easeOut(duration: 0.72)) { revealProgress = 1 }
    }
  }

  private var formattedTotalTokens: String {
    Int64(points.reduce(0) { $0 + $1.tokens }).formatted(.number.grouping(.automatic))
  }

  private func chartCoordinates(width: CGFloat, height: CGFloat, maximum: Double) -> [CGPoint] {
    let horizontalInset: CGFloat = 3
    let topInset: CGFloat = 5
    let bottomInset: CGFloat = 3
    let usableWidth = max(1, width - horizontalInset * 2)
    let usableHeight = max(1, height - topInset - bottomInset)
    return points.enumerated().map { index, point in
      let x = points.count > 1
        ? horizontalInset + usableWidth * CGFloat(index) / CGFloat(points.count - 1)
        : width / 2
      let normalized = max(0, min(1, point.tokens / maximum))
      let y = topInset + usableHeight * (1 - CGFloat(normalized))
      return CGPoint(x: x, y: y)
    }
  }

  private func linePath(_ coordinates: [CGPoint]) -> Path {
    Path { path in
      guard let first = coordinates.first else { return }
      path.move(to: first)
      for coordinate in coordinates.dropFirst() {
        path.addLine(to: coordinate)
      }
    }
  }

  private func areaPath(_ coordinates: [CGPoint], baseline: CGFloat) -> Path {
    Path { path in
      guard let first = coordinates.first, let last = coordinates.last else { return }
      path.move(to: CGPoint(x: first.x, y: baseline))
      path.addLine(to: first)
      for coordinate in coordinates.dropFirst() {
        path.addLine(to: coordinate)
      }
      path.addLine(to: CGPoint(x: last.x, y: baseline))
      path.closeSubpath()
    }
  }

  private func nearestIndex(to x: CGFloat, width: CGFloat) -> Int? {
    guard !points.isEmpty else { return nil }
    guard points.count > 1, width > 0 else { return 0 }
    let fraction = max(0, min(1, x / width))
    return Int((fraction * CGFloat(points.count - 1)).rounded())
  }

  private func shouldLabel(index: Int) -> Bool {
    let stride = points.count <= 7 ? 1 : points.count <= 31 ? 5 : 15
    return index.isMultiple(of: stride) || index == points.count - 1
  }

  private func axisLabel(for point: DailyUsagePoint) -> String {
    if points.count <= 7 {
      return point.date.usageDayLabel(.dateTime.weekday(.abbreviated))
    }
    return point.date.usageDayLabel(.dateTime.month(.defaultDigits).day())
  }

  private func hoverText(for point: DailyUsagePoint) -> String {
    let date = point.date.usageDayLabel(.dateTime.month(.abbreviated).day())
    let tokens = Int64(point.tokens).formatted(.number.grouping(.automatic))
    let text = RouterLanguage.isSimplifiedChinese ? "\(date) · \(tokens) token" : "\(date) · \(tokens) tok"
    guard point.isRouterFallback else { return text }
    return "\(text) · \(routerLocalized("local fallback"))"
  }
}


// Internal rather than private: the status panel's quota-reset rows in
// ModelRouterTrayApp.swift render the same provider mark.
enum ProviderIconLayout {
  static func fittedRect(sourceRect: NSRect, targetSize: NSSize) -> NSRect {
    guard sourceRect.width > 0, sourceRect.height > 0, targetSize.width > 0, targetSize.height > 0 else {
      return .zero
    }
    let scale = min(
      targetSize.width / sourceRect.width,
      targetSize.height / sourceRect.height
    )
    let drawSize = NSSize(width: sourceRect.width * scale, height: sourceRect.height * scale)
    return NSRect(
      x: (targetSize.width - drawSize.width) / 2,
      y: (targetSize.height - drawSize.height) / 2,
      width: drawSize.width,
      height: drawSize.height
    )
  }

  static func visibleImageRect(_ image: NSImage) -> NSRect {
    guard let representation = image.representations
      .compactMap({ $0 as? NSBitmapImageRep })
      .max(by: { ($0.pixelsWide * $0.pixelsHigh) < ($1.pixelsWide * $1.pixelsHigh) }),
      representation.hasAlpha
    else {
      return NSRect(origin: .zero, size: image.size)
    }

    var minX = representation.pixelsWide
    var minY = representation.pixelsHigh
    var maxX = -1
    var maxY = -1
    for y in 0..<representation.pixelsHigh {
      for x in 0..<representation.pixelsWide {
        if representation.colorAt(x: x, y: y)?.alphaComponent ?? 0 > 8.0 / 255.0 {
          minX = min(minX, x)
          minY = min(minY, y)
          maxX = max(maxX, x)
          maxY = max(maxY, y)
        }
      }
    }
    guard maxX >= minX, maxY >= minY else {
      return NSRect(origin: .zero, size: image.size)
    }
    return NSRect(
      x: image.size.width * CGFloat(minX) / CGFloat(representation.pixelsWide),
      y: image.size.height * CGFloat(minY) / CGFloat(representation.pixelsHigh),
      width: image.size.width * CGFloat(maxX - minX + 1) / CGFloat(representation.pixelsWide),
      height: image.size.height * CGFloat(maxY - minY + 1) / CGFloat(representation.pixelsHigh)
    )
  }
}

struct ProviderIcon: View {
  let providerID: String
  let size: CGFloat
  var showsHelp: Bool = true

  var body: some View {
    let mark = Group {
      if let providerImage {
        Image(nsImage: providerImage)
          .resizable()
          .interpolation(.high)
          .scaledToFit()
          // Keep provider marks inside the same point-sized slot as preset
          // icons in both the menu bar and Dynamic Island.
          .frame(width: size, height: size)
          .clipped()
      } else {
        Image(systemName: "cpu")
          .font(.system(size: size * 0.82, weight: .semibold))
          .foregroundStyle(routerMuted)
          .frame(width: size, height: size)
      }
    }
    .frame(width: size, height: size)
    .accessibilityLabel(providerName)

    if showsHelp {
      mark.help(providerName)
    } else {
      mark
    }
  }

  private var providerImage: NSImage? {
    guard let assetName else { return nil }
    // Installed apps keep SwiftPM resources in the standard sealed resources
    // directory. Bundle.module remains the development fallback for swift run.
    let installedBundle = Bundle.main.resourceURL
      .map { $0.appendingPathComponent("ModelRouterTray_ModelRouterTray.bundle") }
      .flatMap(Bundle.init(url:))
    let resources = installedBundle ?? Bundle.module
    let url = resources.url(
      forResource: assetName,
      withExtension: assetExtension,
      subdirectory: "ProviderIcons"
    ) ?? resources.url(forResource: assetName, withExtension: assetExtension)
    guard let image = url.flatMap(NSImage.init(contentsOf:)) else { return nil }
    return fittedProviderImage(image)
  }

  private func fittedProviderImage(_ image: NSImage) -> NSImage {
    let targetSize = NSSize(width: max(1, size), height: max(1, size))
    let sourceRect = ProviderIconLayout.visibleImageRect(image)
    let drawRect = ProviderIconLayout.fittedRect(sourceRect: sourceRect, targetSize: targetSize)
    let fitted = NSImage(size: targetSize)
    fitted.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(
      in: drawRect,
      from: sourceRect,
      operation: .sourceOver,
      fraction: 1,
      respectFlipped: true,
      hints: [.interpolation: NSImageInterpolation.high]
    )
    fitted.unlockFocus()
    return fitted
  }

  private var assetName: String? {
    if providerID == "openai" { return "openai" }
    if providerID == "vertex" { return "google" }
    if providerID.hasPrefix("grok") { return "grok" }
    if providerID.hasPrefix("kimi") { return "kimi" }
    if providerID == "deepseek" { return "deepseek" }
    if providerID == "anthropic-api" { return "anthropic" }
    if providerID.hasPrefix("commandcode") { return "commandcode" }
    if providerID == "github-copilot" { return "github-copilot" }
    if providerID == "chutes" { return "chutes" }
    if providerID == "venice" { return "venice" }
    if providerID == "nousresearch" { return "nousresearch" }
    if providerID == "openrouter" { return "openrouter" }
    if providerID == "nano-gpt" { return "nano-gpt" }
    // opencode-free plus the opencode-go API/Messages/Responses routes.
    if providerID.hasPrefix("opencode") { return "opencode-free" }
    if providerID == "kilo-free" { return "kilo-free" }
    if providerID.hasPrefix("zai-") { return "zai" }
    if providerID == "qwen-plan" { return "qwen" }
    // Local models run through the same Ollama runtime the cloud tier uses.
    if providerID == "ollama-cloud" || providerID == "local" { return "ollama" }
    if providerID == "clinepass" { return "cline" }
    if providerID == "minimax-token-plan" { return "minimax" }
    if providerID == "meta" { return "meta" }
    return nil
  }

  private var assetExtension: String {
    // Keyed off the asset, not the provider id, so every route sharing a mark
    // (opencode-go and friends) resolves the same file type.
    ["github-copilot", "chutes", "google", "opencode-free", "kilo-free", "nano-gpt"].contains(assetName ?? "") ? "svg" : "png"
  }

  private var providerName: String {
    if providerID == "openai" { return "ChatGPT" }
    if providerID == "vertex" { return "Google Cloud Vertex AI" }
    if providerID.hasPrefix("grok") { return "Grok" }
    if providerID.hasPrefix("kimi") { return "Kimi" }
    if providerID == "deepseek" { return "DeepSeek" }
    if providerID == "anthropic-api" { return "Anthropic" }
    if providerID.hasPrefix("zai-") { return "GLM" }
    if providerID == "qwen-plan" { return "Qwen" }
    if providerID == "ollama-cloud" { return "Ollama" }
    if providerID.hasPrefix("commandcode") { return "Command Code" }
    if providerID == "github-copilot" { return "GitHub Copilot" }
    if providerID == "clinepass" { return "ClinePass" }
    if providerID == "chutes" { return "Chutes" }
    if providerID == "venice" { return "Venice" }
    if providerID == "nousresearch" { return "Nous Research" }
    if providerID == "openrouter" { return "OpenRouter" }
    if providerID == "nano-gpt" { return "NanoGPT" }
    if providerID == "opencode-free" { return "OpenCode Free" }
    if providerID == "kilo-free" { return "Kilo Free" }
    // Deliberately not a vendor name: this provider is a container for
    // whatever endpoints the operator put in it, and its models come from
    // different places.
    if providerID == "custom" { return "Custom" }
    return routerLocalized("Model provider")
  }
}

private struct SessionTextWidthKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}

private struct BouncingSessionName: View {
  @Environment(\.routerReduceMotion) private var reduceMotion
  let text: String
  let fontSize: CGFloat
  let weight: Font.Weight

  @State private var containerWidth: CGFloat = 0
  @State private var textWidth: CGFloat = 0
  @State private var offset: CGFloat = 0
  @State private var animationTask: Task<Void, Never>?

  var body: some View {
    GeometryReader { geometry in
      Text(text)
        .font(.system(size: fontSize, weight: weight, design: .rounded))
        .foregroundStyle(.white.opacity(0.92))
        .fixedSize(horizontal: true, vertical: false)
        .background {
          GeometryReader { textGeometry in
            Color.clear.preference(key: SessionTextWidthKey.self, value: textGeometry.size.width)
          }
        }
        .offset(x: offset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { updateContainerWidth(geometry.size.width) }
        .onChange(of: geometry.size.width) { updateContainerWidth($0) }
    }
    .frame(height: max(14, fontSize + 4))
    .clipped()
    .onPreferenceChange(SessionTextWidthKey.self) { width in
      textWidth = width
      restartAnimation()
    }
    .onChange(of: text) { _ in restartAnimation() }
    .onChange(of: reduceMotion) { _ in restartAnimation() }
    .onDisappear { animationTask?.cancel() }
    .accessibilityLabel(text)
  }

  private func updateContainerWidth(_ width: CGFloat) {
    guard abs(containerWidth - width) > 0.5 else { return }
    containerWidth = width
    restartAnimation()
  }

  private func restartAnimation() {
    animationTask?.cancel()
    withAnimation(nil) { offset = 0 }
    let overflow = max(0, textWidth - containerWidth)
    guard !reduceMotion, containerWidth > 0, overflow > 2 else { return }
    animationTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 850_000_000)
      guard !Task.isCancelled else { return }
      let travelDuration = max(2.8, Double(overflow / 18))
      while !Task.isCancelled {
        withAnimation(.easeInOut(duration: travelDuration)) { offset = -overflow }
        try? await Task.sleep(nanoseconds: UInt64((travelDuration + 0.7) * 1_000_000_000))
        guard !Task.isCancelled else { return }
        withAnimation(.easeInOut(duration: travelDuration)) { offset = 0 }
        try? await Task.sleep(nanoseconds: UInt64((travelDuration + 0.7) * 1_000_000_000))
      }
    }
  }
}

private struct IslandSessionList: View {
  let sessions: [IslandActivitySession]
  let compact: Bool
  var onSelect: ((String) -> Void)?

  init(
    sessions: [IslandActivitySession],
    compact: Bool,
    onSelect: ((String) -> Void)? = nil
  ) {
    self.sessions = sessions
    self.compact = compact
    self.onSelect = onSelect
  }

  var body: some View {
    VStack(spacing: compact ? 5 : 7) {
      ForEach(sessions) { session in
        Group {
          if let onSelect {
            Button { onSelect(session.id) } label: { row(session) }
              .buttonStyle(.plain)
          } else {
            row(session)
          }
        }
      }
    }
  }

  private func row(_ session: IslandActivitySession) -> some View {
    HStack(spacing: 9) {
      ProviderIcon(providerID: session.requests.first?.provider ?? "openai", size: compact ? 22 : 26)
      VStack(alignment: .leading, spacing: 2) {
        Text(session.name)
          .font(.system(size: compact ? 10.5 : 11.5, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.94))
          .lineLimit(1)
        Text(
          RouterLanguage.isSimplifiedChinese
            ? "\(session.agents.count) 个代理"
            : "\(session.agents.count) \(session.agents.count == 1 ? "agent" : "agents")"
        )
          .font(.system(size: 8.5, weight: .medium, design: .monospaced))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      if !compact {
        Text(shortModelSummary(session))
          .font(.system(size: 8.5, weight: .medium, design: .rounded))
          .foregroundStyle(routerYellow.opacity(0.9))
          .lineLimit(1)
        Image(systemName: "chevron.right")
          .font(.system(size: 8, weight: .bold))
          .foregroundStyle(routerMuted)
      }
    }
    .padding(.horizontal, compact ? 8 : 11)
    .padding(.vertical, compact ? 5 : 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .background(Color.white.opacity(0.038), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(Color.white.opacity(0.055), lineWidth: 0.5)
    }
  }

  private func shortModelSummary(_ session: IslandActivitySession) -> String {
    let models = Array(Set(session.agents.compactMap(\.model))).sorted()
    guard let first = models.first else { return routerLocalized("Active") }
    let short = first.split(separator: "/").last.map(String.init) ?? first
    return models.count == 1 ? short : "\(short) +\(models.count - 1)"
  }
}

private struct IslandAgentList: View {
  @ObservedObject var store: RouterStore
  let session: IslandActivitySession

  var body: some View {
    VStack(spacing: 7) {
      ForEach(session.agents) { request in
        HStack(spacing: 10) {
          ProviderIcon(providerID: request.provider, size: 24)
          VStack(alignment: .leading, spacing: 2) {
            Text(agentLabel(request))
              .font(.system(size: 11, weight: .semibold, design: .rounded))
              .foregroundStyle(.white.opacity(0.94))
              .lineLimit(1)
            Text(store.modelLabel(for: request))
              .font(.system(size: 8.5, weight: .medium, design: .monospaced))
              .foregroundStyle(routerMuted)
              .lineLimit(1)
          }
          Spacer()
          TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(elapsedLabel(for: request, now: context.date))
              .font(.system(size: 9, weight: .medium, design: .rounded))
              .foregroundStyle(routerYellow.opacity(0.95))
              .monospacedDigit()
          }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(Color.white.opacity(0.038), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(Color.white.opacity(0.055), lineWidth: 0.5)
        }
      }
    }
  }

  private func agentLabel(_ request: RouterActiveRequest) -> String {
    if let name = request.agentName, !name.isEmpty {
      return name.replacingOccurrences(of: "_", with: " ")
    }
    if let nickname = request.agentNickname, !nickname.isEmpty { return nickname }
    return request.isSubagent == true ? "Agent" : "Primary"
  }

  private func elapsedLabel(for request: RouterActiveRequest, now: Date) -> String {
    let started = Date(timeIntervalSince1970: request.startedAt / 1000)
    let seconds = max(0, Int(now.timeIntervalSince(started)))
    if seconds < 60 { return "\(seconds)s" }
    return "\(seconds / 60)m \(seconds % 60)s"
  }
}

private struct ActiveRequestList: View {
  @ObservedObject var store: RouterStore
  let limit: Int
  let compact: Bool

  var body: some View {
    VStack(spacing: compact ? 5 : 6) {
      ForEach(Array(store.activeRequests.prefix(limit))) { request in
        HStack(spacing: 8) {
          ProviderIcon(providerID: request.provider, size: compact ? 22 : 24)
          BouncingSessionName(
            text: store.sessionName(for: request),
            fontSize: compact ? 10.5 : 11,
            weight: .semibold
          )
          .frame(maxWidth: .infinity)
          TimelineView(.periodic(from: .now, by: 1)) { context in
            let elapsed = elapsedLabel(for: request, now: context.date)
            Text(RouterLanguage.isSimplifiedChinese
              ? "思考中 · \(elapsed)"
              : "Thinking · \(elapsed)")
              .font(.system(size: compact ? 8.5 : 9, weight: .medium, design: .rounded))
              .foregroundStyle(routerYellow.opacity(0.95))
              .monospacedDigit()
              .fixedSize()
          }
        }
        .padding(.horizontal, compact ? 8 : 10)
        .padding(.vertical, compact ? 5 : 7)
        .background(Color.white.opacity(0.038), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .stroke(Color.white.opacity(0.055), lineWidth: 0.5)
        }
      }
      if store.activeRequests.count > limit {
        Text(RouterLanguage.isSimplifiedChinese
          ? "+\(store.activeRequests.count - limit) 个更多"
          : "+\(store.activeRequests.count - limit) more")
          .font(.system(size: 9, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private func elapsedLabel(for request: RouterActiveRequest, now: Date) -> String {
    let started = Date(timeIntervalSince1970: request.startedAt / 1000)
    let seconds = max(0, Int(now.timeIntervalSince(started)))
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    let rem = seconds % 60
    return "\(minutes)m \(rem)s"
  }
}

private struct IslandSilhouette: InsettableShape {
  var inset: CGFloat = 0

  func path(in rect: CGRect) -> Path {
    let r = rect.insetBy(dx: inset, dy: inset)
    let radius = min(22, r.height * 0.34)
    var path = Path()
    path.move(to: CGPoint(x: r.minX, y: r.minY))
    path.addLine(to: CGPoint(x: r.maxX, y: r.minY))
    path.addLine(to: CGPoint(x: r.maxX, y: r.maxY - radius))
    path.addCurve(
      to: CGPoint(x: r.maxX - radius, y: r.maxY),
      control1: CGPoint(x: r.maxX, y: r.maxY - radius * 0.38),
      control2: CGPoint(x: r.maxX - radius * 0.38, y: r.maxY)
    )
    path.addLine(to: CGPoint(x: r.minX + radius, y: r.maxY))
    path.addCurve(
      to: CGPoint(x: r.minX, y: r.maxY - radius),
      control1: CGPoint(x: r.minX + radius * 0.38, y: r.maxY),
      control2: CGPoint(x: r.minX, y: r.maxY - radius * 0.38)
    )
    path.closeSubpath()
    return path
  }

  func inset(by amount: CGFloat) -> IslandSilhouette {
    var copy = self
    copy.inset += amount
    return copy
  }
}

private struct LiveOrb: View {
  @Environment(\.routerReduceMotion) private var reduceMotion
  let state: RouterActivityState
  var count: Int = 0
  @State private var pulsing = false
  @State private var rippling = false
  @State private var effectTask: Task<Void, Never>?

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Group {
        if state == .idle || state == .generating || state == .error {
          ThinkingOrbView(
            mode: orbMode,
            reduceMotion: reduceMotion,
            size: 18
          )
            .frame(width: 18, height: 18)
        } else {
          ZStack {
            Circle()
              .stroke(state.tint.opacity(0.38), lineWidth: 0.7)
              .frame(width: 11, height: 11)
              .scaleEffect(rippling ? (state == .idle ? 2.0 : 2.3) : 0.72)
              .opacity(rippling ? 0 : (state == .idle ? 0.24 : 0.38))
            Circle()
              .fill(state.tint.opacity(orbHaloOpacity))
              .frame(width: 18, height: 18)
              .scaleEffect(orbHaloScale)
            Circle()
              .fill(state.tint)
              .frame(width: 8, height: 8)
              .overlay(Circle().stroke(Color.white.opacity(0.42), lineWidth: 0.6))
              .scaleEffect(coreScale)
              .opacity(coreOpacity)
              .shadow(
                color: state.tint.opacity(pulsing ? 0.42 : 0.16),
                radius: pulsing ? 3.5 : 1.2
              )
          }
        }
      }
      .frame(width: 18, height: 18)

      if count > 1 {
        Text("\(min(count, 9))")
          .font(.system(size: 7, weight: .bold, design: .rounded))
          .foregroundStyle(.black.opacity(0.88))
          .frame(width: 11, height: 11)
          .background(state.tint, in: Circle())
          .overlay(Circle().stroke(Color.black.opacity(0.35), lineWidth: 0.6))
          .offset(x: 5, y: -4)
      }
    }
    .onAppear { animate() }
    .onChange(of: state) { _ in animate() }
    .onChange(of: count) { _ in animate() }
    .onChange(of: reduceMotion) { _ in animate() }
    .onDisappear { effectTask?.cancel() }
  }

  private var orbMode: ThinkingOrbMode {
    switch state {
    case .generating: return .composing
    case .error: return .solving
    case .idle, .starting: return .shaping
    }
  }

  private var orbHaloOpacity: Double {
    if state == .idle { return pulsing ? 0.16 : 0.08 }
    return pulsing ? 0.24 : 0.13
  }

  private var orbHaloScale: CGFloat {
    if state == .idle { return pulsing ? 1.14 : 0.94 }
    if state == .error { return 1 }
    return pulsing ? 1.28 : 0.92
  }

  private var coreScale: CGFloat {
    if reduceMotion { return 1 }
    switch state {
    case .idle:
      return pulsing ? 1.10 : 0.92
    case .starting, .generating:
      return pulsing ? 1.16 : 0.88
    case .error:
      return pulsing ? 1.18 : 1
    }
  }

  private var coreOpacity: Double {
    if reduceMotion { return 1 }
    if state == .idle { return pulsing ? 1 : 0.76 }
    return pulsing ? 1 : 0.84
  }

  private func animate() {
    effectTask?.cancel()
    withAnimation(nil) {
      pulsing = false
      rippling = false
    }
    // ThinkingOrbView owns animation for idle, generating, and error. These
    // state values only affect the fallback status-dot branch used at startup.
    guard !reduceMotion, state == .starting else { return }

    withAnimation(.easeInOut(duration: 1.35).repeatForever(autoreverses: true)) {
      pulsing = true
    }
    withAnimation(.easeOut(duration: 1.9).repeatForever(autoreverses: false)) {
      rippling = true
    }
  }
}

private struct StatusGlow: View {
  @Environment(\.routerReduceMotion) private var reduceMotion
  let state: RouterActivityState

  @State private var sweepAngle = -120.0
  @State private var sweepOpacity = 0.0
  @State private var breathing = false
  @State private var errorPulse = false
  @State private var effectTask: Task<Void, Never>?

  var body: some View {
    ZStack(alignment: .topLeading) {
      IslandSilhouette()
        .inset(by: 1)
        .strokeBorder(Color.white.opacity(0.065), lineWidth: 0.7)

      if state != .idle {
        IslandSilhouette()
          .inset(by: 1)
          .strokeBorder(state.tint.opacity(edgeOpacity * 0.55), lineWidth: 2.4)
          .blur(radius: 2.2)
        IslandSilhouette()
          .inset(by: 1)
          .strokeBorder(state.tint.opacity(edgeOpacity), lineWidth: edgeLineWidth)
      }

      Circle()
        .fill(
          RadialGradient(
            colors: [state.tint.opacity(0.9), state.tint.opacity(0.18), .clear],
            center: .center,
            startRadius: 0,
            endRadius: 22
          )
        )
        .frame(width: 44, height: 44)
        .offset(x: 1, y: -2)
        .opacity(localHaloOpacity)

      if sweepOpacity > 0.001 {
        IslandSilhouette()
          .inset(by: 1)
          .strokeBorder(sweepGradient(angle: .degrees(sweepAngle)), lineWidth: 3)
          .blur(radius: 2.4)
          .opacity(sweepOpacity * 0.35)
        IslandSilhouette()
          .inset(by: 1)
          .strokeBorder(sweepGradient(angle: .degrees(sweepAngle)), lineWidth: 1.15)
          .opacity(sweepOpacity)
      }

      IslandSilhouette()
        .inset(by: 3.5)
        .strokeBorder(Color.white.opacity(0.035), lineWidth: 0.45)
    }
    .onAppear { restartEffects() }
    .onChange(of: state) { _ in restartEffects() }
    .onChange(of: reduceMotion) { _ in restartEffects() }
    .onDisappear { effectTask?.cancel() }
    .animation(.easeInOut(duration: 0.25), value: state)
    .accessibilityHidden(true)
  }

  private var edgeOpacity: Double {
    switch state {
    case .idle:
      return 0
    case .starting:
      return 0.065
    case .generating:
      return 0.09
    case .error:
      return errorPulse ? 0.22 : 0.12
    }
  }

  private var edgeLineWidth: Double {
    state == .error && errorPulse ? 1.3 : 0.8
  }

  private var localHaloOpacity: Double {
    switch state {
    case .idle:
      return breathing ? 0.11 : 0.045
    case .starting:
      return breathing ? 0.20 : 0.09
    case .generating:
      return breathing ? 0.24 : 0.11
    case .error:
      return errorPulse ? 0.20 : 0.12
    }
  }

  private func sweepGradient(angle: Angle) -> AngularGradient {
    AngularGradient(
      gradient: Gradient(stops: [
        .init(color: .clear, location: 0),
        .init(color: .clear, location: 0.70),
        .init(color: state.tint.opacity(0.20), location: 0.74),
        .init(color: state.tint.opacity(0.68), location: 0.79),
        .init(color: Color.white.opacity(0.28), location: 0.81),
        .init(color: state.tint.opacity(0.42), location: 0.84),
        .init(color: .clear, location: 0.90),
        .init(color: .clear, location: 1),
      ]),
      center: .center,
      startAngle: angle,
      endAngle: .degrees(angle.degrees + 360)
    )
  }

  private func restartEffects() {
    effectTask?.cancel()
    withAnimation(nil) {
      sweepAngle = -120
      sweepOpacity = 0
      breathing = false
      errorPulse = false
    }
    guard !reduceMotion else { return }

    let nextState = state
    effectTask = Task { @MainActor in
      await Task<Never, Never>.yield()
      guard !Task.isCancelled else { return }

      switch nextState {
      case .idle:
        withAnimation(.easeInOut(duration: 3.2).repeatForever(autoreverses: true)) {
          breathing = true
        }
      case .starting:
        withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
          breathing = true
        }
      case .generating:
        withAnimation(nil) {
          sweepAngle = -120
          sweepOpacity = 0.52
        }
        await Task<Never, Never>.yield()
        guard !Task.isCancelled else { return }
        withAnimation(.linear(duration: 3.2).repeatForever(autoreverses: false)) {
          sweepAngle = 240
        }
        withAnimation(.easeInOut(duration: 1.35).repeatForever(autoreverses: true)) {
          breathing = true
        }
      case .error:
        withAnimation(nil) { errorPulse = true }
        await Task<Never, Never>.yield()
        guard !Task.isCancelled else { return }
        withAnimation(.easeOut(duration: 0.8)) { errorPulse = false }
      }
    }
  }
}

private struct MetricTile: View {
  let title: String
  let value: String
  let detail: String
  let tint: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title)
        .font(.system(size: 8, weight: .bold, design: .monospaced))
        .tracking(0.9)
        .foregroundStyle(routerMuted)
      Text(value)
        .font(.system(size: 18, weight: .semibold, design: .rounded))
        .foregroundStyle(tint)
        .monospacedDigit()
      Text(detail)
        .font(.system(size: 9, design: .rounded))
        .foregroundStyle(routerMuted)
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 11)
    .padding(.vertical, 8)
    .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(Color.white.opacity(0.08), lineWidth: 0.6)
    )
  }
}

@MainActor
final class DesktopPanelWindowController {
  static let panelSize = CGSize(width: 356, height: 440)
  private static let frameName = "ModelRouterTray.desktopPanel"
  private let window: NSPanel
  private let store: RouterStore

  init(store: RouterStore) {
    self.store = store
    window = NSPanel(
      contentRect: NSRect(origin: .zero, size: Self.panelSize),
      styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = true
    // Sit just above the desktop icons so the panel behaves like a widget:
    // always readable on the desktop, never covering application windows.
    window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    window.isMovable = true
    window.isMovableByWindowBackground = true
    window.hidesOnDeactivate = false
    window.contentView = nil
    window.setFrameAutosaveName(Self.frameName)
  }

  func setVisible(_ visible: Bool) {
    if visible {
      installContentIfNeeded()
      if !window.setFrameUsingName(Self.frameName), let screen = NSScreen.main {
        let frame = screen.visibleFrame
        window.setFrameOrigin(NSPoint(
          x: frame.maxX - Self.panelSize.width - 24,
          y: frame.maxY - Self.panelSize.height - 24
        ))
      }
      window.orderFrontRegardless()
    } else {
      window.orderOut(nil)
      window.contentView = nil
    }
  }

  private func installContentIfNeeded() {
    guard window.contentView == nil else { return }
    window.contentView = NSHostingView(
      rootView: DesktopPanelView(store: store)
        .frame(width: Self.panelSize.width, height: Self.panelSize.height)
        .preferredColorScheme(.dark)
    )
  }
}

private struct DesktopPanelView: View {
  @ObservedObject var store: RouterStore
  @State private var range: UsageRange = .week
  // The island deliberately pins routerReduceMotion on, but this panel is
  // summoned rather than always visible, so its charts and orb keep honouring
  // the system Reduce Motion setting.
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header

      Rectangle()
        .fill(Color.white.opacity(0.07))
        .frame(height: 0.5)
        .padding(.vertical, 12)

      HStack(alignment: .bottom, spacing: 12) {
        VStack(alignment: .leading, spacing: 3) {
          Text(routerLocalized("Daily token usage").uppercased())
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .tracking(0.9)
            .foregroundStyle(routerMuted)
          Text(DesktopWidgetPresentation.tokenCountLabel(store.selectedTodayTokens))
            .font(.system(size: 30, weight: .medium, design: .rounded))
            .tracking(-0.8)
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.68)
        }

        Spacer(minLength: 4)

        VStack(alignment: .trailing, spacing: 5) {
          HStack(spacing: 6) {
            ProviderIcon(providerID: store.selectedUsageProviderID, size: 14)
            Text(store.selectedUsageProvider.shortName)
              .font(.system(size: 10, weight: .semibold, design: .rounded))
              .lineLimit(1)
          }
          Text(store.selectedUsageText ?? routerLocalized("Awaiting data"))
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(store.selectedUsageText == nil ? routerMuted : store.activityState.tint)
            .lineLimit(1)
        }
      }
      .frame(minHeight: 59)

      if store.hasConcurrentActivity {
        ActiveRequestList(store: store, limit: 2, compact: true)
          .padding(.top, 10)
      } else {
        activityStrip
          .padding(.top, 10)
      }

      sectionHeading(routerLocalized("Quota resets"), trailing: quotaSummary)
        .padding(.top, 14)

      if store.desktopQuotaRows.isEmpty {
        Text(routerLocalized("Connect a provider to see its quota here."))
          .font(.system(size: 10, design: .rounded))
          .foregroundStyle(routerMuted)
          .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
      } else {
        ScrollView(.vertical, showsIndicators: false) {
          VStack(spacing: 9) {
            ForEach(store.desktopQuotaRows) { row in
              DesktopQuotaBarRow(row: row)
            }
          }
        }
        .frame(maxHeight: 128)
      }

      Spacer(minLength: 0)

      HStack(alignment: .center, spacing: 8) {
        Text(routerLocalized("Router traffic").uppercased())
          .font(.system(size: 8, weight: .bold, design: .monospaced))
          .tracking(0.9)
          .foregroundStyle(routerMuted)
        Spacer()
        compactRangePicker
      }
      .padding(.bottom, 5)

      IslandUsageLineChart(points: store.dailyUsage(days: range.rawValue), tint: routerAccent)
        .id("desktop-\(store.selectedUsageProviderID)-\(range.rawValue)")
        .frame(height: 52)
    }
    .environment(\.routerReduceMotion, systemReduceMotion)
    .padding(17)
    .background(
      ZStack {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(islandBezel.opacity(0.985))
        LinearGradient(
          colors: [routerAccent.opacity(0.11), Color.clear, routerMint.opacity(0.025)],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
      }
    )
    .overlay(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .stroke(Color.white.opacity(0.11), lineWidth: 0.8)
    )
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Codex Router usage widget")
  }

  private var header: some View {
    HStack(spacing: 10) {
      Image(systemName: "point.3.filled.connected.trianglepath.dotted")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(routerAccent)
        .frame(width: 26, height: 26)
        .background(routerAccent.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

      VStack(alignment: .leading, spacing: 1) {
        Text("Codex Router")
          .font(.system(size: 12, weight: .semibold, design: .rounded))
        Text(routerLocalized("Usage and live activity"))
          .font(.system(size: 8.5, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
      }

      Spacer()

      HStack(spacing: 6) {
        Circle()
          .fill(store.activityState.tint)
          .frame(width: 5, height: 5)
        Text(store.activityState.label.uppercased())
          .font(.system(size: 8, weight: .bold, design: .monospaced))
          .tracking(0.7)
          .foregroundStyle(store.activityState.tint)
      }
    }
  }

  private var activityStrip: some View {
    HStack(spacing: 8) {
      LiveOrb(state: store.activityState, count: store.activeChatCount)
        .scaleEffect(0.78)
        .frame(width: 24, height: 24)
      VStack(alignment: .leading, spacing: 1) {
        Text(store.activitySummaryLabel)
          .font(.system(size: 10, weight: .semibold, design: .rounded))
          .foregroundStyle(store.activityState.tint)
        Text(activityDetail)
          .font(.system(size: 8.5, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
          .lineLimit(1)
      }
      Spacer()
      if let speed = store.activeModelObservedTokensPerSecond {
        Text(String(format: "%.1f tok/s", speed))
          .font(.system(size: 9, weight: .semibold, design: .monospaced))
          .foregroundStyle(routerMint)
          .monospacedDigit()
      }
    }
    .padding(.horizontal, 10)
    .frame(height: 38)
    .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(Color.white.opacity(0.07), lineWidth: 0.6)
    )
  }

  private var activityDetail: String {
    guard let request = store.activeRequests.last else {
      return routerLocalized("Ready for the next request")
    }
    return "\(store.shortName(forProvider: request.provider)) / \(store.modelLabel(for: request))"
  }

  private var quotaSummary: String {
    let count = store.desktopQuotaRows.count
    if count == 0 { return routerLocalized("None") }
    return RouterLanguage.isSimplifiedChinese ? "\(count) 个窗口" : "\(count) window\(count == 1 ? "" : "s")"
  }

  private func sectionHeading(_ title: String, trailing: String) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title.uppercased())
        .font(.system(size: 8, weight: .bold, design: .monospaced))
        .tracking(0.9)
        .foregroundStyle(routerMuted)
      Spacer()
      Text(trailing.uppercased())
        .font(.system(size: 7.5, weight: .semibold, design: .monospaced))
        .tracking(0.5)
        .foregroundStyle(routerMuted)
    }
    .padding(.bottom, 7)
  }

  private var compactRangePicker: some View {
    HStack(spacing: 2) {
      ForEach([UsageRange.week, .month]) { candidate in
        Button {
          range = candidate
        } label: {
          Text(candidate.label)
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .foregroundStyle(range == candidate ? routerText : routerMuted)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
              range == candidate ? Color.white.opacity(0.09) : Color.clear,
              in: Capsule()
            )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(range == candidate ? .isSelected : [])
      }
    }
    .padding(2)
    .background(Color.white.opacity(0.035), in: Capsule())
  }
}

private struct DesktopQuotaBarRow: View {
  let row: DesktopQuotaRow

  private var tint: Color {
    switch DesktopWidgetPresentation.quotaSeverity(row.remainingPercent) {
    case .critical: return routerRed
    case .warning: return routerYellow
    case .healthy: return routerMint
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        ProviderIcon(providerID: row.providerID, size: 14)
        Text(row.providerName)
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .lineLimit(1)
        Spacer()
        Text("\(Int(row.remainingPercent.rounded()))% left")
          .font(.system(size: 10, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .foregroundStyle(tint)
      }
      GeometryReader { geometry in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.white.opacity(0.08))
          Capsule()
            .fill(tint)
            .frame(width: max(3, geometry.size.width * min(1, row.remainingPercent / 100)))
        }
      }
      .frame(height: 4)

      HStack(spacing: 6) {
        Text(row.label)
          .lineLimit(1)
        Spacer()
        if let resetAt = row.resetAt {
          Text(resetCountdownLabel(Date(timeIntervalSince1970: resetAt)))
            .monospacedDigit()
        }
      }
      .font(.system(size: 8, weight: .medium, design: .rounded))
      .foregroundStyle(routerMuted)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(DesktopWidgetPresentation.quotaAccessibilityLabel(row))
  }
}

/// Layout constants and the pure text mapping for the per-account quota table.
/// Kept `nonisolated` and free of view state so the island's height math and the
/// tests can use them without a main-actor hop.
enum IslandAccountQuotaPresentation {
  static let rowHeight: CGFloat = 18
  static let toggleWidth: CGFloat = 16
  static let toggleHitWidth: CGFloat = 22
  static let toggleHeight: CGFloat = 9
  static let headerHeight: CGFloat = 16
  static let rankWidth: CGFloat = 12
  static let quotaWidth: CGFloat = 32
  static let countdownWidth: CGFloat = 36
  static let bankedResetWidth: CGFloat = 34

  /// A null window is not a zero window: the probe could not read it, and
  /// rendering `0%` there would claim the subscription is spent.
  nonisolated static func percentText(_ remaining: Double?) -> String {
    guard let remaining, remaining.isFinite else { return "—" }
    return "\(Int(remaining.rounded()))%"
  }

  nonisolated static func resetBackText(
    _ resetsAt: TimeInterval?,
    now: Date = Date()
  ) -> String {
    guard let resetsAt, resetsAt.isFinite else { return "—" }
    let remaining = Date(timeIntervalSince1970: resetsAt).timeIntervalSince(now)
    if remaining <= 0 { return "now" }
    let minutes = max(1, Int((remaining / 60).rounded(.up)))
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    let leftover = minutes % 60
    if hours < 24 {
      return leftover == 0 ? "\(hours)h" : "\(hours)h\(leftover)"
    }
    return "\(hours / 24)d\(hours % 24)h"
  }

  /// Rotation position, or an em dash when rotation left the account out.
  nonisolated static func rankText(_ rank: Int?) -> String {
    guard let rank else { return "—" }
    return "\(rank)"
  }

  /// One trailing tag per row, because two would not fit. The reason an account
  /// is unusable outranks its plan: a `pro` badge on a spent account tells the
  /// user nothing they need.
  nonisolated static func tagKey(
    health: ChatGptAccountHealth,
    planType: String?,
    hasError: Bool,
    inRotation: Bool
  ) -> String? {
    if hasError { return "probe failed" }
    switch health {
    case .drained: return "spent"
    case .soft: return "low"
    case .unknown: return inRotation ? planTag(planType) ?? "no data" : "no data"
    case .healthy: return planTag(planType)
    }
  }

  nonisolated static func planTag(_ planType: String?) -> String? {
    guard let planType else { return nil }
    let trimmed = planType.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed.lowercased()
  }

  nonisolated static func tableHeight(rows: Int) -> CGFloat {
    guard rows > 0 else { return headerHeight + rowHeight }
    return headerHeight + CGFloat(rows) * rowHeight
  }
}

/// The user's dense on/off pill. It reports whether rotation will use an account
/// and is deliberately not a control: the pool exposes `select` but no
/// pause/enable verb, so a switch wired to a write would have nothing to call.
private struct IslandDenseSwitch: View {
  let isOn: Bool
  var locked = false

  var body: some View {
    ZStack(alignment: isOn ? .trailing : .leading) {
      Capsule()
        .fill(trackColor)
        .frame(
          width: IslandAccountQuotaPresentation.toggleWidth,
          height: IslandAccountQuotaPresentation.toggleHeight
        )
      Circle()
        .fill(Color.white.opacity(locked ? 0.62 : 0.94))
        .frame(width: 7, height: 7)
        .padding(.horizontal, 1)
    }
    .animation(.easeInOut(duration: 0.12), value: isOn)
  }

  private var trackColor: Color {
    // `locked` dims the track but must not erase the on/off reading: a locked
    // pill that looks identical either way tells the user nothing.
    if isOn { return routerAccent.opacity(locked ? 0.55 : 0.92) }
    return Color.white.opacity(locked ? 0.12 : 0.16)
  }
}

/// Per-account quota for every ChatGPT subscription in the pool, in the order
/// rotation will use them. The top row is the account the next turn gets.
private struct IslandAccountQuotaTable: View {
  @ObservedObject var store: RouterStore

  var body: some View {
    TimelineView(.periodic(from: .now, by: 15)) { timeline in
      VStack(alignment: .leading, spacing: 2) {
        header
        if let snapshot = store.chatGptAccountUsage, !snapshot.accounts.isEmpty {
          let ranks = snapshot.rotationRanks
          ForEach(snapshot.orderedRows()) { account in
            row(
              account,
              rank: ranks[account.id],
              preferred: snapshot.isPreferred(account, override: store.chatGptPreferredOverride),
              now: timeline.date
            )
          }
        } else {
          Text(routerLocalized("Loading native Codex usage…"))
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(routerMuted)
            .frame(height: IslandAccountQuotaPresentation.rowHeight, alignment: .leading)
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(routerLocalized("All usage"))
    .onAppear {
      Task {
        await store.refreshNativeUsageIfStale(maxAge: 5.0)
      }
    }
  }

  private var header: some View {
    HStack(spacing: 5) {
      Color.clear
        .frame(width: IslandAccountQuotaPresentation.toggleHitWidth)
      Text(headerTitle)
        .font(.system(size: 8, weight: .semibold, design: .monospaced))
        .foregroundStyle(routerMuted)
        .lineLimit(1)
      Spacer()
      Text(shortColumnTitle)
        .frame(width: IslandAccountQuotaPresentation.quotaWidth, alignment: .trailing)
      Text("in")
        .frame(width: IslandAccountQuotaPresentation.countdownWidth, alignment: .trailing)
      Text(longColumnTitle)
        .frame(width: IslandAccountQuotaPresentation.quotaWidth, alignment: .trailing)
      if showsBankedResets {
        Text(routerLocalized("RESET"))
          .frame(width: IslandAccountQuotaPresentation.bankedResetWidth, alignment: .trailing)
          .lineLimit(1)
          .minimumScaleFactor(0.55)
      }
    }
    .font(.system(size: 8, weight: .semibold, design: .monospaced))
    .foregroundStyle(routerMuted)
    .frame(height: IslandAccountQuotaPresentation.headerHeight)
  }

  /// The columns name the window they are actually showing, taken from the pool
  /// rather than assumed: an account can report a 5-hour short window while
  /// another reports none at all. The fallbacks apply only when no account
  /// contributed a duration.
  private var shortColumnTitle: String {
    dominantLabel(store.chatGptAccountWindows.shortWindow) ?? "5h"
  }

  private var longColumnTitle: String {
    dominantLabel(store.chatGptAccountWindows.longWindow) ?? "7d"
  }

  private var showsBankedResets: Bool {
    (store.chatGptAccountUsage?.accounts ?? []).contains {
      $0.bankedResetCount > 0 || store.isResetCreditCountUnverified($0.id)
        || store.canRetryPendingChatGptResetCredit($0.id)
    }
  }

  /// The label shared by the most accounts. A pool whose accounts disagree about
  /// a window's length has no single honest header, so the most common one wins
  /// and the per-row tooltip carries the exact window.
  private func dominantLabel(_ windows: [String: ChatGptWindowFacts]) -> String? {
    var counts: [String: Int] = [:]
    for window in windows.values {
      guard let label = window.shortLabel else { continue }
      counts[label, default: 0] += 1
    }
    return counts.max { left, right in
      left.value == right.value ? left.key > right.key : left.value < right.value
    }?.key
  }

  /// Names how many subscriptions rotation can actually reach, which is the
  /// number that matters when one has drained out of the set.
  private var headerTitle: String {
    guard let snapshot = store.chatGptAccountUsage, !snapshot.accounts.isEmpty else {
      return routerLocalized("All usage")
    }
    let usable = snapshot.rotation.count
    guard usable > 0 else {
      return "\(routerLocalized("All usage")) · \(routerLocalized("no rotation"))"
    }
    return "\(routerLocalized("All usage")) · \(usable)/\(snapshot.accounts.count) \(routerLocalized("in rotation"))"
  }

  @ViewBuilder
  private func row(
    _ account: ChatGptAccountPoolRow,
    rank: Int?,
    preferred: Bool,
    now: Date
  ) -> some View {
    let excluded = rank == nil
    let windows = resolvedWindows(for: account)
    HStack(spacing: 5) {
      IslandDenseSwitch(isOn: !excluded, locked: true)
        .frame(
          width: IslandAccountQuotaPresentation.toggleHitWidth,
          height: IslandAccountQuotaPresentation.rowHeight
        )
        .help(rotationHelp(account, rank: rank))
        .accessibilityHidden(true)
        .opacity(excluded ? 0.55 : 1)

      Button {
        Task { await store.preferChatGptAccount(account.id) }
      } label: {
        HStack(spacing: 5) {
          Text(IslandAccountQuotaPresentation.rankText(rank))
            .font(.system(size: 8.5, weight: .bold, design: .monospaced))
            .foregroundStyle(rank == 1 ? routerAccent : routerMuted)
            .frame(width: IslandAccountQuotaPresentation.rankWidth, alignment: .trailing)
          if preferred {
            Text("●")
              .font(.system(size: 7, weight: .bold))
              .foregroundStyle(routerAccent)
          }
          Text(account.displayLabel)
            .font(.system(size: 10, weight: preferred ? .semibold : .medium, design: .rounded))
            .foregroundStyle(excluded ? routerMuted : .white.opacity(0.92))
            .lineLimit(1)
            .truncationMode(.middle)
          if let tag = IslandAccountQuotaPresentation.tagKey(
            health: account.health,
            planType: account.planType,
            hasError: account.error != nil,
            inRotation: !excluded
          ) {
            Text(routerLocalized(tag).uppercased())
              .font(.system(size: 7, weight: .semibold, design: .monospaced))
              .foregroundStyle(tagTint(account))
              .lineLimit(1)
              .fixedSize()
          }
          Spacer(minLength: 4)
          quotaValue(windows.short?.remainingPercent)
          countdownValue(windows: windows, now: now)
          quotaValue(windows.long?.remainingPercent)
        }
        .frame(height: IslandAccountQuotaPresentation.rowHeight)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(preferred || store.chatGptAccountOperation != nil)
      .help(
        preferred
          ? routerLocalized("Preferred subscription")
          : routerLocalized("Click to prefer this subscription")
      )
      .accessibilityLabel(accessibilityLabel(for: account, rank: rank, now: now))
      .accessibilityHint(
        preferred ? "" : routerLocalized("Double-click to prefer this subscription")
      )
      .opacity(excluded ? 0.55 : 1)
      if showsBankedResets {
        bankedResetControl(for: account)
      }
    }
    .frame(height: IslandAccountQuotaPresentation.rowHeight)
  }

  @ViewBuilder
  private func bankedResetControl(for account: ChatGptAccountPoolRow) -> some View {
    if store.canRetryPendingChatGptResetCredit(account.id) {
      Button {
        store.showPendingChatGptResetCredit(account.id)
      } label: {
        Image(systemName: "questionmark.arrow.circlepath")
          .font(.system(size: 10, weight: .semibold))
          .frame(width: IslandAccountQuotaPresentation.bankedResetWidth,
                 height: IslandAccountQuotaPresentation.rowHeight)
      }
      .buttonStyle(.plain)
      .help(routerLocalized("Reset result unknown; reopen the saved attempt"))
      .accessibilityLabel(routerLocalized("Review uncertain reset attempt"))
    } else if store.isResetCreditCountUnverified(account.id) {
      Image(systemName: "ellipsis")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(routerMuted)
        .frame(width: IslandAccountQuotaPresentation.bankedResetWidth,
               height: IslandAccountQuotaPresentation.rowHeight)
        .help(routerLocalized("Waiting for a fresh reset credit balance"))
        .accessibilityLabel(routerLocalized("Reset credit balance is being refreshed"))
    } else if store.visibleBankedResetCount(for: account) > 0 {
      Button {
        store.requestChatGptResetCredit(account.id)
      } label: {
        HStack(spacing: 2) {
          Image(systemName: "arrow.counterclockwise")
            .font(.system(size: 9, weight: .bold))
          Text("\(account.bankedResetCount)")
            .font(.system(size: 9, weight: .bold, design: .rounded))
            .monospacedDigit()
        }
        .foregroundStyle(.white.opacity(account.canRedeemBankedReset ? 0.95 : 0.5))
        .frame(width: IslandAccountQuotaPresentation.bankedResetWidth,
               height: IslandAccountQuotaPresentation.rowHeight)
        .background(routerAccent.opacity(account.canRedeemBankedReset ? 0.40 : 0.16),
                    in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!account.canRedeemBankedReset || store.chatGptAccountOperation != nil)
      .help(bankedResetHelp(for: account))
      .accessibilityLabel(routerFormat("Use a banked reset credit on %@",
                                       account.displayLabel))
      .accessibilityHint(routerLocalized("Opens a confirmation; usable when a rate limit is at least 90% spent"))
    } else {
      Color.clear
        .frame(width: IslandAccountQuotaPresentation.bankedResetWidth,
               height: IslandAccountQuotaPresentation.rowHeight)
        .accessibilityHidden(true)
    }
  }

  private func bankedResetHelp(for account: ChatGptAccountPoolRow) -> String {
    let available = routerFormat("%d banked reset credits available for %@",
                                 account.bankedResetCount, account.displayLabel)
    if account.authInvalid {
      return "\(available). \(routerLocalized("Sign in to use a reset credit."))"
    }
    if !account.canRedeemBankedReset {
      return "\(available). \(routerLocalized("A core rate limit must be at least 90% spent."))"
    }
    return available
  }

  /// Rotation excludes an account for reasons the snapshot does not always
  /// report -- a paused account, an expired session, or a duplicate identity are
  /// simply absent -- so an unexplained exclusion says only that, rather than
  /// guessing at a cause.
  private func rotationHelp(_ account: ChatGptAccountPoolRow, rank: Int?) -> String {
    if let rank {
      return rank == 1
        ? routerLocalized("Next turn uses this subscription")
        : routerFormat("In rotation, position %d", rank)
    }
    if account.error != nil { return routerLocalized("Usage probe failed for this subscription") }
    if account.health == .drained { return routerLocalized("Out of rotation: quota is spent") }
    return routerLocalized("Out of rotation")
  }

  /// Classifies an account's windows by duration rather than by the slot they
  /// arrived in. The slots are positional: an account whose only window is
  /// weekly reports it in `primary`, so reading the first slot as the short
  /// window shows a weekly percentage under a 5-hour heading.
  ///
  /// Deliberately no fallback to the projection's slots. Guessing a window's
  /// identity from its position is the error this exists to avoid, and a dash is
  /// honest where a confidently mislabelled number is not. The cache must also be
  /// the same probe the snapshot came from, or the two describe different
  /// moments -- the probe rewrites that file on its own schedule.
  private func resolvedWindows(
    for account: ChatGptAccountPoolRow
  ) -> (short: ChatGptWindowFacts?, long: ChatGptWindowFacts?) {
    let durations = store.chatGptAccountWindows
    guard durations.matches(store.chatGptAccountUsage) else { return (nil, nil) }
    return (durations.shortWindow[account.id], durations.longWindow[account.id])
  }

  private func quotaValue(_ remaining: Double?) -> some View {
    Text(IslandAccountQuotaPresentation.percentText(remaining))
      .font(.system(size: 10.5, weight: .semibold, design: .rounded))
      .monospacedDigit()
      .foregroundStyle(quotaTint(remaining))
      .frame(width: IslandAccountQuotaPresentation.quotaWidth, alignment: .trailing)
  }

  /// Counts down the short window when one was read, since that is the limit a
  /// turn hits first. Held colour-neutral: the reset belongs to a window, not to
  /// a severity, and tinting it by a percentage it does not describe would read
  /// as a warning about the wrong number.
  private func countdownValue(
    windows: (short: ChatGptWindowFacts?, long: ChatGptWindowFacts?),
    now: Date
  ) -> some View {
    let window = windows.short ?? windows.long
    let text = IslandAccountQuotaPresentation.resetBackText(window?.resetsAt, now: now)
    let label = window?.shortLabel
    return Text(text)
      .font(.system(size: 10, weight: .semibold, design: .rounded))
      .monospacedDigit()
      .foregroundStyle(text == "—" ? routerMuted : .white.opacity(0.82))
      .frame(width: IslandAccountQuotaPresentation.countdownWidth, alignment: .trailing)
      .help(
        label.map { routerFormat("%@ limit resets in", $0) }
          ?? routerLocalized("Limit resets in")
      )
  }

  private func quotaTint(_ remaining: Double?) -> Color {
    guard let remaining else { return routerMuted }
    switch DesktopWidgetPresentation.quotaSeverity(remaining) {
    case .critical: return routerRed
    case .warning: return routerYellow
    case .healthy: return .white.opacity(0.92)
    }
  }

  private func tagTint(_ account: ChatGptAccountPoolRow) -> Color {
    if account.error != nil { return routerRed }
    switch account.health {
    case .drained: return routerRed
    case .soft: return routerYellow
    case .unknown, .healthy: return routerMuted
    }
  }

  private func accessibilityLabel(
    for account: ChatGptAccountPoolRow,
    rank: Int?,
    now: Date
  ) -> String {
    let windows = resolvedWindows(for: account)
    let short = IslandAccountQuotaPresentation.percentText(windows.short?.remainingPercent)
    let long = IslandAccountQuotaPresentation.percentText(windows.long?.remainingPercent)
    let back = IslandAccountQuotaPresentation.resetBackText(
      (windows.short ?? windows.long)?.resetsAt, now: now)
    let position = rank
      .map { routerFormat("rotation position %d", $0) }
      ?? routerLocalized("out of rotation")
    let plan = IslandAccountQuotaPresentation.planTag(account.planType).map { ", \($0)" } ?? ""
    let banked = account.bankedResetCount > 0
      ? ", \(account.bankedResetCount) \(routerLocalized("banked reset credits available"))"
      : ""
    let shortName = windows.short?.shortLabel ?? shortColumnTitle
    let longName = windows.long?.shortLabel ?? longColumnTitle
    return "\(account.displayLabel)\(plan), \(position), \(shortName) \(short), "
      + "\(longName) \(long), resets in \(back)\(banked)"
  }
}

enum DesktopWidgetQuotaSeverity: Equatable {
  case healthy
  case warning
  case critical
}

enum DesktopWidgetPresentation {
  nonisolated static func tokenCountLabel(_ value: Double) -> String {
    RouterWidgetTokenCount.from(value).formatted(.number.grouping(.automatic))
  }

  nonisolated static func quotaSeverity(_ remainingPercent: Double) -> DesktopWidgetQuotaSeverity {
    if remainingPercent <= 10 { return .critical }
    if remainingPercent <= 30 { return .warning }
    return .healthy
  }

  nonisolated static func quotaAccessibilityLabel(
    _ row: DesktopQuotaRow,
    now: Date = Date()
  ) -> String {
    let remaining = "\(Int(row.remainingPercent.rounded())) percent left"
    guard let resetAt = row.resetAt else {
      return "\(row.providerName), \(row.label), \(remaining)"
    }
    let reset = resetCountdownLabel(
      Date(timeIntervalSince1970: resetAt),
      now: now,
      chinese: false
    )
    return "\(row.providerName), \(row.label), \(remaining), \(reset)"
  }
}
