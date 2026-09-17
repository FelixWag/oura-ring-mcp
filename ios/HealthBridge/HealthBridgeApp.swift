import HealthKit
import SwiftUI

@main
struct HealthBridgeApp: App {
    @StateObject private var settings = Settings()
    @StateObject private var sync: SyncService

    init() {
        let settings = Settings()
        _settings = StateObject(wrappedValue: settings)
        _sync = StateObject(wrappedValue: SyncService(settings: settings))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .environmentObject(sync)
                .task {
                    // Authorisation and background delivery are idempotent;
                    // asking on every launch keeps them in step with whatever
                    // the user has since toggled in the Health app.
                    try? await HealthKitReader.requestAuthorization()
                    try? await HealthKitReader.enableBackgroundDelivery()
                    await sync.sync()
                }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var settings: Settings
    @EnvironmentObject private var sync: SyncService
    @State private var showingToken = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://host:8771", text: $settings.serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)

                    HStack {
                        if showingToken {
                            TextField("Token", text: $settings.token)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        } else {
                            SecureField("Token", text: $settings.token)
                        }
                        Button(showingToken ? "Hide" : "Show") { showingToken.toggle() }
                            .font(.footnote)
                    }
                }

                Section("Status") {
                    LabeledContent("Last sync") {
                        Text(sync.lastSync.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "Never")
                            .foregroundStyle(.secondary)
                    }
                    Text(sync.lastResult)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Button {
                        Task { await sync.sync() }
                    } label: {
                        HStack {
                            Text("Sync now")
                            Spacer()
                            if sync.isSyncing { ProgressView() }
                        }
                    }
                    .disabled(sync.isSyncing || !settings.isConfigured)

                    Button("Re-send all history", role: .destructive) {
                        sync.resetAnchors()
                        Task { await sync.sync() }
                    }
                    .disabled(sync.isSyncing || !settings.isConfigured)
                } footer: {
                    Text("Workouts, body composition and nutrition sync automatically when new data arrives. Re-sending is harmless — the server keeps one copy of each record.")
                }
            }
            .navigationTitle("Health Bridge")
        }
    }
}
