import Foundation
import HealthKit

/// Reads HealthKit and hands back JSON-ready payloads.
///
/// Two things Shortcuts cannot do, and the reason this app exists:
/// workouts are `HKWorkout` objects rather than quantity samples, so the
/// Shortcuts "Find Health Samples" action cannot see them at all; and every
/// sample's `uuid` survives, which makes server-side dedupe exact instead of
/// a guess based on timestamps.
///
/// Queries are anchored: HealthKit returns what changed since the last run,
/// so a sync sends deltas rather than the whole history every time.
enum HealthKitReader {
    static let store = HKHealthStore()

    /// Quantity types mirrored to the server, with the unit each is sent in.
    /// Add a type here and it flows end to end — the server's `sample_type`
    /// is generic, so no schema change is needed.
    static let quantityTypes: [(identifier: HKQuantityTypeIdentifier, sampleType: String, unit: HKUnit)] = [
        (.bodyMass, "body_mass", .gramUnit(with: .kilo)),
        (.bodyFatPercentage, "body_fat_percentage", .percent()),
        (.leanBodyMass, "lean_body_mass", .gramUnit(with: .kilo)),
        (.dietaryEnergyConsumed, "dietary_energy_consumed", .kilocalorie()),
        (.dietaryProtein, "dietary_protein", .gram()),
        (.dietaryCarbohydrates, "dietary_carbohydrates", .gram()),
        (.dietaryFatTotal, "dietary_fat_total", .gram()),
        (.dietaryFatSaturated, "dietary_fat_saturated", .gram()),
        (.dietarySugar, "dietary_sugar", .gram()),
        (.dietaryFiber, "dietary_fiber", .gram()),
        (.dietarySodium, "dietary_sodium", .gramUnit(with: .milli)),
        (.dietaryPotassium, "dietary_potassium", .gramUnit(with: .milli)),
        (.dietaryCholesterol, "dietary_cholesterol", .gramUnit(with: .milli)),
        (.dietaryWater, "dietary_water", .literUnit(with: .milli)),
    ]

    static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [HKObjectType.workoutType()]
        for entry in quantityTypes {
            if let t = HKQuantityType.quantityType(forIdentifier: entry.identifier) {
                types.insert(t)
            }
        }
        return types
    }

    static func requestAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw BridgeError.healthDataUnavailable
        }
        // Read-only: the app never writes to HealthKit, so `toShare` is empty.
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    // MARK: - Workouts

    /// New or changed workouts since `anchor`.
    ///
    /// HealthKit will not say whether *it* considers two records duplicates —
    /// that judgement is the server's. Every record is sent as it stands,
    /// including its source app, so the server can resolve them.
    static func fetchWorkouts(anchor: HKQueryAnchor?) async throws -> (workouts: [[String: Any]], anchor: HKQueryAnchor?) {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: HKObjectType.workoutType(),
                predicate: nil,
                anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, samples, _, newAnchor, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let workouts = (samples as? [HKWorkout] ?? []).map(encode)
                continuation.resume(returning: (workouts, newAnchor))
            }
            store.execute(query)
        }
    }

    private static func encode(_ workout: HKWorkout) -> [String: Any] {
        var payload: [String: Any] = [
            // The UUID is the whole point of reading natively: it makes
            // re-sending the same workout a no-op on the server.
            "external_id": workout.uuid.uuidString,
            "source": "apple_health",
            "source_name": workout.sourceRevision.source.name,
            "activity_type": name(for: workout.workoutActivityType),
            "start_time": iso8601.string(from: workout.startDate),
            "end_time": iso8601.string(from: workout.endDate),
            "duration_min": workout.duration / 60.0,
            "created_at": iso8601.string(from: workout.startDate),
        ]

        // A device is attached when the phone recorded the session live. The
        // server uses its presence to tell a live-activity wrapper from the
        // app's own typed record.
        if let device = workout.device {
            payload["device"] = [device.name, device.manufacturer, device.model]
                .compactMap { $0 }
                .joined(separator: ", ")
        }

        let energy = workout.statistics(for: HKQuantityType(.activeEnergyBurned))?
            .sumQuantity()?.doubleValue(for: .kilocalorie())
        if let energy { payload["energy_kcal"] = energy }

        let distance = workout.statistics(for: HKQuantityType(.distanceWalkingRunning))?
            .sumQuantity()?.doubleValue(for: .meterUnit(with: .kilo))
        if let distance { payload["distance_km"] = distance }

        let heartRate = workout.statistics(for: HKQuantityType(.heartRate))?
            .averageQuantity()?.doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
        if let heartRate { payload["avg_heart_rate"] = heartRate }

        return payload
    }

    // MARK: - Quantity samples

    static func fetchSamples(
        for entry: (identifier: HKQuantityTypeIdentifier, sampleType: String, unit: HKUnit),
        anchor: HKQueryAnchor?
    ) async throws -> (samples: [[String: Any]], anchor: HKQueryAnchor?) {
        guard let type = HKQuantityType.quantityType(forIdentifier: entry.identifier) else {
            return ([], anchor)
        }
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: type,
                predicate: nil,
                anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, samples, _, newAnchor, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let encoded = (samples as? [HKQuantitySample] ?? []).map { sample in
                    [
                        "sample_type": entry.sampleType,
                        "value": sample.quantity.doubleValue(for: entry.unit),
                        "unit": entry.unit.unitString,
                        "start_time": iso8601.string(from: sample.startDate),
                        "end_time": iso8601.string(from: sample.endDate),
                        "source_name": sample.sourceRevision.source.name,
                    ] as [String: Any]
                }
                continuation.resume(returning: (encoded, newAnchor))
            }
            store.execute(query)
        }
    }

    // MARK: - Background delivery

    /// Ask HealthKit to wake the app when new data lands, so a sync doesn't
    /// depend on the app being opened. iOS decides the actual timing.
    static func enableBackgroundDelivery() async throws {
        try await store.enableBackgroundDelivery(
            for: HKObjectType.workoutType(),
            frequency: .immediate
        )
        for entry in quantityTypes {
            if let type = HKQuantityType.quantityType(forIdentifier: entry.identifier) {
                try? await store.enableBackgroundDelivery(for: type, frequency: .hourly)
            }
        }
    }

    // MARK: - Helpers

    /// ISO 8601 with the local offset. The offset matters: "which day was
    /// this workout" is a local-time question, and the server keeps the
    /// string verbatim.
    static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone.current
        return f
    }()

    /// HealthKit activity types are an enum; the server stores the same
    /// strings an Apple Health export writes, so history and live data agree.
    static func name(for type: HKWorkoutActivityType) -> String {
        switch type {
        case .traditionalStrengthTraining: return "TraditionalStrengthTraining"
        case .functionalStrengthTraining: return "FunctionalStrengthTraining"
        case .coreTraining: return "CoreTraining"
        case .crossTraining: return "CrossTraining"
        case .highIntensityIntervalTraining: return "HighIntensityIntervalTraining"
        case .walking: return "Walking"
        case .running: return "Running"
        case .cycling: return "Cycling"
        case .swimming: return "Swimming"
        case .rowing: return "Rowing"
        case .yoga: return "Yoga"
        case .flexibility: return "Flexibility"
        case .hiking: return "Hiking"
        case .dance: return "Dance"
        case .tableTennis: return "TableTennis"
        case .tennis: return "Tennis"
        case .soccer: return "Soccer"
        case .stairClimbing: return "StairClimbing"
        case .elliptical: return "Elliptical"
        case .pilates: return "Pilates"
        case .climbing: return "Climbing"
        case .mixedCardio: return "MixedCardio"
        // Apple maps anything without a match to .other, which is NOT a
        // duplicate marker — stretching commonly lands here.
        case .other: return "Other"
        @unknown default: return "Unknown"
        }
    }
}

enum BridgeError: LocalizedError {
    case healthDataUnavailable
    case notConfigured
    case server(status: Int, body: String)

    var errorDescription: String? {
        switch self {
        case .healthDataUnavailable:
            return "Health data isn't available on this device."
        case .notConfigured:
            return "Set the server URL and token first."
        case let .server(status, body):
            return "Server returned \(status): \(body)"
        }
    }
}
