import Foundation
import HealthKit

/// Drives a sync: read what changed, POST it, remember how far we got.
///
/// Anchors are the whole design. HealthKit hands back an opaque anchor with
/// each query; storing it means the next run asks only for what changed. A
/// sync is therefore cheap enough to run on every background wake, and
/// re-running one is harmless — the server dedupes on HealthKit's UUIDs.
@MainActor
final class SyncService: ObservableObject {
    @Published private(set) var lastSync: Date?
    @Published private(set) var lastResult: String = "Never synced"
    @Published private(set) var isSyncing = false

    private let settings: Settings
    private let defaults = UserDefaults.standard

    init(settings: Settings) {
        self.settings = settings
        self.lastSync = defaults.object(forKey: "lastSync") as? Date
        if let stored = defaults.string(forKey: "lastResult") { self.lastResult = stored }
    }

    func sync() async {
        guard !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }

        do {
            guard settings.isConfigured else { throw BridgeError.notConfigured }

            let (workouts, workoutAnchor) = try await HealthKitReader.fetchWorkouts(
                anchor: loadAnchor(key: "anchor.workouts")
            )
            if !workouts.isEmpty {
                try await post(path: "/v1/health/workouts", body: ["workouts": workouts])
            }
            // Only advance the anchor once the POST succeeded, so a failed
            // sync retries the same records instead of skipping them.
            save(anchor: workoutAnchor, key: "anchor.workouts")

            var sampleCount = 0
            for entry in HealthKitReader.quantityTypes {
                let key = "anchor.\(entry.sampleType)"
                let (samples, anchor) = try await HealthKitReader.fetchSamples(
                    for: entry,
                    anchor: loadAnchor(key: key)
                )
                if !samples.isEmpty {
                    try await post(path: "/v1/health/import", body: ["samples": samples])
                    sampleCount += samples.count
                }
                save(anchor: anchor, key: key)
            }

            let now = Date()
            lastSync = now
            lastResult = workouts.isEmpty && sampleCount == 0
                ? "Up to date"
                : "Sent \(workouts.count) workout(s), \(sampleCount) sample(s)"
            defaults.set(now, forKey: "lastSync")
            defaults.set(lastResult, forKey: "lastResult")
        } catch {
            lastResult = "Failed: \(error.localizedDescription)"
            defaults.set(lastResult, forKey: "lastResult")
        }
    }

    // MARK: - Networking

    private func post(path: String, body: [String: Any]) async throws {
        guard let url = URL(string: settings.serverURL + path) else {
            throw BridgeError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(settings.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 60

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw BridgeError.server(
                status: status,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
    }

    // MARK: - Anchor storage

    private func loadAnchor(key: String) -> HKQueryAnchor? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func save(anchor: HKQueryAnchor?, key: String) {
        guard let anchor,
              let data = try? NSKeyedArchiver.archivedData(
                  withRootObject: anchor,
                  requiringSecureCoding: true
              )
        else { return }
        defaults.set(data, forKey: key)
    }

    /// Forget every anchor, so the next sync re-sends all history. Safe by
    /// construction: the server ignores what it already has.
    func resetAnchors() {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("anchor.") {
            defaults.removeObject(forKey: key)
        }
        lastResult = "Anchors reset — next sync re-sends everything"
    }
}

/// Server URL and token, kept out of the source so the app is publishable.
final class Settings: ObservableObject {
    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    @Published var token: String {
        didSet { UserDefaults.standard.set(token, forKey: "token") }
    }

    var isConfigured: Bool {
        !serverURL.isEmpty && !token.isEmpty && URL(string: serverURL) != nil
    }

    init() {
        self.serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        self.token = UserDefaults.standard.string(forKey: "token") ?? ""
    }
}
