import Foundation
import Testing

@testable import ModelRouterTray

// The island's per-account quota table is only as good as its agreement with
// `control chatgpt-account-pool usage cached`. The fixture below is a verbatim
// capture of that command's output on a live five-subscription pool, including
// the awkward rows: one account the probe could not read at all, and two the
// router has ranked out of rotation for being spent.
@Suite("ChatGPT account pool usage")
struct ChatGptAccountPoolTests {
  // Captured 2026-09-20 from the installed router.
  static let liveFixture = """
  {"fetchedAt":"2026-09-20T05:05:44.377Z",
   "rotation":["acct_ITrjHwzqNRfqT9Ja","acct_nEsBPIMG6cBLohPX","acct_YFTkG8SXQvuTnlNQ"],
   "accounts":[
    {"id":"acct_ITrjHwzqNRfqT9Ja","label":"gurbaksh@chahal.com","preferred":true,
     "planType":"pro","health":"healthy","primaryRemainingPercent":45,
     "secondaryRemainingPercent":null,"resetsAt":1790419714},
    {"id":"acct_nEsBPIMG6cBLohPX","label":"ChatGPT account 1","preferred":false,
     "planType":null,"health":"unknown","primaryRemainingPercent":null,
     "secondaryRemainingPercent":null,"resetsAt":null},
    {"id":"acct_PAwPDjTco-y4UXr4","label":"gc@veerone.com","preferred":false,
     "planType":"plus","health":"drained","primaryRemainingPercent":0,
     "secondaryRemainingPercent":69,"resetsAt":1790307829},
    {"id":"acct_YFTkG8SXQvuTnlNQ","label":"rubina.bajwa@auraone.ai","preferred":false,
     "planType":"plus","health":"healthy","primaryRemainingPercent":100,
     "secondaryRemainingPercent":37,"resetsAt":1790306780},
    {"id":"acct_-IRDM2FImlLioLmM","label":"gchahal@chahalfoundation.org","preferred":false,
     "planType":"plus","health":"drained","primaryRemainingPercent":0,
     "secondaryRemainingPercent":27,"resetsAt":1790061047}]}
  """

  static func decodeLive() throws -> ChatGptAccountPoolUsage {
    try JSONDecoder().decode(
      ChatGptAccountPoolUsage.self,
      from: Data(liveFixture.utf8)
    )
  }

  @Test("the live payload decodes, including null windows and absent plans")
  func decodesLivePayload() throws {
    let snapshot = try Self.decodeLive()
    #expect(snapshot.accounts.count == 5)
    #expect(snapshot.rotation.count == 3)
    #expect(snapshot.fetchedAt == "2026-09-20T05:05:44.377Z")

    let home = snapshot.accounts[0]
    #expect(home.label == "gurbaksh@chahal.com")
    #expect(home.preferred)
    #expect(home.planType == "pro")
    #expect(home.health == .healthy)
    #expect(home.primaryRemainingPercent == 45)
    // A weekly window the probe did not report stays nil rather than becoming 0.
    #expect(home.secondaryRemainingPercent == nil)
    #expect(home.resetsAt == 1_790_419_714)

    let unread = snapshot.accounts[1]
    #expect(unread.health == .unknown)
    #expect(unread.planType == nil)
    #expect(unread.primaryRemainingPercent == nil)
    #expect(unread.resetsAt == nil)
  }

  @Test("rotation order drives the table, with excluded accounts after it")
  func ordersByRotation() throws {
    let snapshot = try Self.decodeLive()
    let ranks = snapshot.rotationRanks
    #expect(ranks["acct_ITrjHwzqNRfqT9Ja"] == 1)
    #expect(ranks["acct_nEsBPIMG6cBLohPX"] == 2)
    #expect(ranks["acct_YFTkG8SXQvuTnlNQ"] == 3)
    // Spent accounts are absent from rotation, not ranked last within it.
    #expect(ranks["acct_PAwPDjTco-y4UXr4"] == nil)
    #expect(ranks["acct_-IRDM2FImlLioLmM"] == nil)

    #expect(snapshot.nextAccountId == "acct_ITrjHwzqNRfqT9Ja")
    #expect(snapshot.orderedRows().map(\.id) == [
      "acct_ITrjHwzqNRfqT9Ja",
      "acct_nEsBPIMG6cBLohPX",
      "acct_YFTkG8SXQvuTnlNQ",
      "acct_PAwPDjTco-y4UXr4",
      "acct_-IRDM2FImlLioLmM",
    ])
  }

  @Test("a duplicate id in rotation ranks once instead of trapping")
  func duplicateRotationIdIsSafe() {
    let snapshot = ChatGptAccountPoolUsage(
      fetchedAt: nil,
      rotation: ["acct_a", "acct_a", "acct_b"],
      accounts: [
        ChatGptAccountPoolRow(id: "acct_b", label: "b"),
        ChatGptAccountPoolRow(id: "acct_a", label: "a"),
      ]
    )
    #expect(snapshot.rotationRanks == ["acct_a": 1, "acct_b": 3])
    #expect(snapshot.orderedRows().map(\.id) == ["acct_a", "acct_b"])
  }

  @Test("an unfamiliar health verdict degrades instead of blanking the table")
  func unknownHealthDecodes() throws {
    let row = try JSONDecoder().decode(
      ChatGptAccountPoolRow.self,
      from: Data(#"{"id":"acct_x","label":"x","health":"quarantined"}"#.utf8)
    )
    #expect(row.health == .unknown)
    #expect(!row.preferred)
  }

  @Test("an unlabeled account still identifies itself")
  func fallsBackToAccountIdTail() {
    let row = ChatGptAccountPoolRow(id: "acct_ITrjHwzqNRfqT9Ja", label: "   ")
    #expect(row.displayLabel == "qNRfqT9Ja".suffix(8).description)
  }

  @Test("the local selection outranks a probe-time preferred flag")
  func overrideWinsUntilTheSnapshotAgrees() throws {
    let snapshot = try Self.decodeLive()
    let home = snapshot.accounts[0]
    let other = snapshot.accounts[3]
    #expect(snapshot.isPreferred(home, override: nil))
    #expect(!snapshot.isPreferred(other, override: nil))
    // After a successful `select`, the cached flag is stale for one poll.
    #expect(!snapshot.isPreferred(home, override: other.id))
    #expect(snapshot.isPreferred(other, override: other.id))
  }

  @Test("a null window reads as unknown, never as spent")
  func percentTextSeparatesNullFromZero() {
    #expect(IslandAccountQuotaPresentation.percentText(nil) == "—")
    #expect(IslandAccountQuotaPresentation.percentText(0) == "0%")
    #expect(IslandAccountQuotaPresentation.percentText(45) == "45%")
    #expect(IslandAccountQuotaPresentation.percentText(.nan) == "—")
  }

  @Test("reset countdowns collapse to the largest two useful units")
  func resetCountdownText() {
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    let at = { (offset: TimeInterval) in
      IslandAccountQuotaPresentation.resetBackText(
        now.addingTimeInterval(offset).timeIntervalSince1970,
        now: now
      )
    }
    #expect(IslandAccountQuotaPresentation.resetBackText(nil, now: now) == "—")
    #expect(at(-30) == "now")
    #expect(at(45 * 60) == "45m")
    #expect(at(2 * 3600) == "2h")
    #expect(at(2 * 3600 + 14 * 60) == "2h14")
    #expect(at(3 * 24 * 3600 + 5 * 3600) == "3d5h")
  }

  @Test("rotation position renders, and exclusion reads as a dash")
  func rankText() {
    #expect(IslandAccountQuotaPresentation.rankText(1) == "1")
    #expect(IslandAccountQuotaPresentation.rankText(3) == "3")
    #expect(IslandAccountQuotaPresentation.rankText(nil) == "—")
  }

  @Test("the reason an account is unusable outranks its plan badge")
  func tagPrecedence() {
    #expect(
      IslandAccountQuotaPresentation.tagKey(
        health: .healthy, planType: "pro", hasError: false, inRotation: true
      ) == "pro"
    )
    // A plan badge on a spent subscription tells the user nothing they need.
    #expect(
      IslandAccountQuotaPresentation.tagKey(
        health: .drained, planType: "plus", hasError: false, inRotation: false
      ) == "spent"
    )
    #expect(
      IslandAccountQuotaPresentation.tagKey(
        health: .soft, planType: "plus", hasError: false, inRotation: true
      ) == "low"
    )
    #expect(
      IslandAccountQuotaPresentation.tagKey(
        health: .healthy, planType: "pro", hasError: true, inRotation: true
      ) == "probe failed"
    )
    // An unread account that rotation still trusts shows what it is instead.
    #expect(
      IslandAccountQuotaPresentation.tagKey(
        health: .unknown, planType: nil, hasError: false, inRotation: true
      ) == "no data"
    )
    #expect(
      IslandAccountQuotaPresentation.tagKey(
        health: .healthy, planType: nil, hasError: false, inRotation: true
      ) == nil
    )
  }

  // The projection's two slots are positional, so the window each one holds has
  // to be recovered from the cache document's `windowDurationMins`. This fixture
  // is the real pool: the home account's ONLY window is weekly and arrives in
  // `primary`, exactly where a slot-order reading would call it "5h".
  static let liveCacheFixture = """
  {"version":1,"fetchedAt":"2026-09-20T05:05:44.377Z","accounts":[
   {"id":"acct_ITrjHwzqNRfqT9Ja","label":"gurbaksh@chahal.com","preferred":true,
    "primary":{"usedPercent":55,"remainingPercent":45,"windowDurationMins":10080,
               "resetsAt":1790419714},
    "secondary":null},
   {"id":"acct_nEsBPIMG6cBLohPX","label":"ChatGPT account 1","primary":null,"secondary":null},
   {"id":"acct_PAwPDjTco-y4UXr4","label":"gc@veerone.com",
    "primary":{"usedPercent":100,"remainingPercent":0,"windowDurationMins":300,
               "resetsAt":1789880977},
    "secondary":{"usedPercent":31,"remainingPercent":69,"windowDurationMins":10080,
                 "resetsAt":1790307829}}]}
  """

  @Test("windows are classified by duration, not by which slot they arrived in")
  func classifiesWindowsByDuration() {
    let durations = ChatGptAccountWindowDurations.parse(Data(Self.liveCacheFixture.utf8))

    // The home account's weekly window sits in `primary`. It must land in the
    // long column, not the short one, or its 45% reads as a 5-hour figure.
    let home = "acct_ITrjHwzqNRfqT9Ja"
    #expect(durations.shortWindow[home] == nil)
    #expect(durations.longWindow[home]?.remainingPercent == 45)
    #expect(durations.longWindow[home]?.durationMinutes == 10_080)
    #expect(durations.longWindow[home]?.shortLabel == "7d")

    // An account with both windows classifies each into its own column.
    let both = "acct_PAwPDjTco-y4UXr4"
    #expect(durations.shortWindow[both]?.remainingPercent == 0)
    #expect(durations.shortWindow[both]?.shortLabel == "5h")
    #expect(durations.longWindow[both]?.remainingPercent == 69)
    #expect(durations.longWindow[both]?.shortLabel == "7d")

    // An account the probe could not read contributes no windows at all.
    #expect(durations.shortWindow["acct_nEsBPIMG6cBLohPX"] == nil)
    #expect(durations.longWindow["acct_nEsBPIMG6cBLohPX"] == nil)
  }

  @Test("an unreadable or absent cache degrades to no durations")
  func missingCacheDegrades() {
    #expect(ChatGptAccountWindowDurations.parse(Data("not json".utf8)) == .empty)
    #expect(ChatGptAccountWindowDurations.parse(Data("{}".utf8)) == .empty)
    // A window with no duration cannot be classified into either column.
    let undated = #"{"accounts":[{"id":"acct_x","primary":{"remainingPercent":50}}]}"#
    #expect(ChatGptAccountWindowDurations.parse(Data(undated.utf8)) == .empty)
  }

  // The probe rewrites the cache on its own schedule, so the tray's two reads --
  // the CLI projection and the duration document -- can straddle a rewrite. That
  // pairs one probe's window lengths with another's percentages, which showed up
  // in practice as a spent account rendering 100%.
  @Test("durations are used only when they come from the snapshot's own probe")
  func staleDurationsAreRefused() {
    let durations = ChatGptAccountWindowDurations.parse(Data(Self.liveCacheFixture.utf8))
    #expect(durations.fetchedAt == "2026-09-20T05:05:44.377Z")

    let sameProbe = ChatGptAccountPoolUsage(
      fetchedAt: "2026-09-20T05:05:44.377Z", rotation: [], accounts: [])
    #expect(durations.matches(sameProbe))

    let laterProbe = ChatGptAccountPoolUsage(
      fetchedAt: "2026-09-20T05:28:07.688Z", rotation: [], accounts: [])
    #expect(!durations.matches(laterProbe))

    // Nothing to compare is not a match: a missing timestamp on either side
    // cannot establish that the two describe the same moment.
    #expect(!durations.matches(ChatGptAccountPoolUsage(
      fetchedAt: nil, rotation: [], accounts: [])))
    #expect(!durations.matches(nil))
    #expect(!ChatGptAccountWindowDurations.empty.matches(sameProbe))
  }

  @Test("the state directory matches paths.mjs")
  func stateDirectoryMatchesRouter() {
    let home = URL(fileURLWithPath: "/Users/someone", isDirectory: true)
    #expect(
      RouterStateDirectory.resolve(environment: [:], home: home).path
        == "/Users/someone/.codex/codex-router"
    )
    #expect(
      RouterStateDirectory.resolve(
        environment: ["CODEX_HOME": "/tmp/ch"], home: home
      ).path == "/tmp/ch/codex-router"
    )
    #expect(
      RouterStateDirectory.resolve(
        environment: ["MODEL_ROUTER_STATE_DIR": "/tmp/state"], home: home
      ).path == "/tmp/state"
    )
  }

  @Test("the island grows with the row count instead of clipping rows")
  func tableHeightGrows() {
    let empty = IslandAccountQuotaPresentation.tableHeight(rows: 0)
    let five = IslandAccountQuotaPresentation.tableHeight(rows: 5)
    // The placeholder row keeps the empty table from collapsing to a header.
    #expect(empty == IslandAccountQuotaPresentation.headerHeight
      + IslandAccountQuotaPresentation.rowHeight)
    #expect(five == IslandAccountQuotaPresentation.headerHeight
      + 5 * IslandAccountQuotaPresentation.rowHeight)
    #expect(five > empty)
    #expect(IslandAccountQuotaPresentation.tableHeight(rows: 6) > five)
  }

  @Test("the cached usage read is not classified as a mutation")
  func cachedReadIsARead() {
    #expect(
      RouterControlContractPolicy.access(for: ["chatgpt-account-pool", "usage", "cached"])
        == .read
    )
    // The bare form re-probes every account; it must never be a tray read.
    #expect(
      RouterControlContractPolicy.access(for: ["chatgpt-account-pool", "usage"]) == .mutation
    )
    #expect(
      RouterControlContractPolicy.access(for: ["chatgpt-account-pool", "select", "acct_a"])
        == .mutation
    )
  }
}
