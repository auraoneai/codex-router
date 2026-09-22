import Foundation
import Testing

@testable import ModelRouterTray

@Suite("Engineering routing tray contract")
struct EngineeringRoutingTests {
  private func snapshot(
    status: String = "ok",
    fresh: Bool = true,
    enabled: Bool = false,
    healthy: Bool = true,
    degraded: Bool = false,
    revision: Any = 7
  ) throws -> RouterSnapshot {
    let payload: [String: Any] = [
      "targets": [:],
      "catalog": [
        "engineering": [
          "version": 1,
          "revision": revision,
          "status": status,
          "fresh": fresh,
          "configured": true,
          "enabled": enabled,
          "healthy": healthy,
          "degraded": degraded,
          "activePreset": "balanced",
          "roles": [
            "complex_coder": [
              "candidates": [
                ["model": "kiro-prism/claude-sonnet-5", "effort": "high"],
              ],
              "optionalCandidates": [],
            ],
          ],
          "usage": ["requests": 0, "fields": [:]],
          "gates": [
            "codexTargetOnly": true,
            "manualOptIn": true,
            "compareAndSwap": true,
            "ordinaryRoutingUnaffected": true,
          ],
          "updatedAt": "2026-09-22T12:00:00.000Z",
        ],
      ],
    ]
    return try JSONDecoder().decode(
      RouterSnapshot.self,
      from: JSONSerialization.data(withJSONObject: payload)
    )
  }

  @Test("older snapshots without engineering metadata remain readable")
  func olderSnapshotCompatibility() throws {
    let data = try JSONSerialization.data(withJSONObject: ["targets": [:]])
    let decoded = try JSONDecoder().decode(RouterSnapshot.self, from: data)

    #expect(decoded.engineering == nil)
  }

  @Test("catalog engineering metadata exposes preset and role model effort")
  func decodesCatalogEngineering() throws {
    let engineering = try #require(snapshot().engineering)
    let candidate = try #require(engineering.roles["complex_coder"]?.candidates.first)

    #expect(engineering.revision == 7)
    #expect(engineering.activePreset == "balanced")
    #expect(candidate.model == "kiro-prism/claude-sonnet-5")
    #expect(candidate.effort == "high")
  }

  @Test("malformed engineering metadata fails closed without hiding router status")
  func malformedEngineeringIsIsolated() throws {
    let malformed: [String: Any] = [
      "targets": [:],
      "catalog": [
        "dashboard": ["enabledProviders": [], "providers": [], "models": []],
        "engineering": ["version": "future-and-incompatible"],
      ],
    ]
    let data = try JSONSerialization.data(withJSONObject: malformed)
    let decoded = try JSONDecoder().decode(RouterSnapshot.self, from: data)

    #expect(decoded.dashboard != nil)
    #expect(decoded.engineering == nil)
    #expect(!RouterEngineeringControlPolicy.canChange(to: true, snapshot: decoded.engineering))
  }

  @Test("unknown stale and degraded states cannot mutate policy")
  func controlFailsClosed() throws {
    let unknown = try snapshot(status: "future").engineering
    let stale = try snapshot(fresh: false).engineering
    let degraded = try snapshot(degraded: true).engineering

    #expect(!RouterEngineeringControlPolicy.canChange(
      to: true,
      snapshot: unknown
    ))
    #expect(!RouterEngineeringControlPolicy.canChange(
      to: true,
      snapshot: stale
    ))
    #expect(!RouterEngineeringControlPolicy.canChange(
      to: true,
      snapshot: degraded
    ))
  }

  @Test("known unhealthy policy may be disabled but cannot be enabled")
  func unhealthyPolicyCanOnlyTurnOff() throws {
    let engineering = try snapshot(enabled: true, healthy: false).engineering

    #expect(RouterEngineeringControlPolicy.canChange(to: false, snapshot: engineering))
    #expect(!RouterEngineeringControlPolicy.canChange(to: true, snapshot: engineering))
  }

  @Test("toggle command carries the exact compare and swap revision")
  func buildsCASArguments() {
    #expect(RouterEngineeringControlPolicy.arguments(enabled: true, revision: 12) == [
      "engineering", "on", "--revision", "12",
    ])
    #expect(RouterEngineeringControlPolicy.arguments(enabled: false, revision: 13) == [
      "engineering", "off", "--revision", "13",
    ])
  }
}
