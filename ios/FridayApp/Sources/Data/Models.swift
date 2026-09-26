import Foundation

// Ported field-for-field from android/app/src/main/java/com/friday/app/data/Models.kt

let AUTO_MODEL_ID = "mode:auto"
let TEAMUP_MODEL_ID = "mode:teamup"

enum Mode: String, CaseIterable, Hashable {
    case search, think, canvas, research
}

enum Role: String, Codable {
    case user, assistant
}

struct Source: Identifiable, Hashable {
    var id: String { url }
    let title: String?
    let url: String
    var snippet: String = ""
}

struct PendingAttachment: Identifiable, Hashable {
    let id: String
    let name: String
    let mime: String
    let size: Int
    let kind: String // "image" | "file"
    let dataUrl: String
}

struct AgentStatus: Identifiable, Hashable {
    var id: String { "\(slug)|\(model)" }
    let slug: String
    let model: String
    var state: String // "start" | "done" | "error"
    var error: String?
}

/// One thing Build Mode did — "Ran command · Install dependencies", "Wrote src/App.jsx".
struct BuildStep: Identifiable, Hashable {
    let id: String
    let kind: String // write | run | start | read
    let label: String
    let state: String // running | ok | error
    var detail: String?
}

/// One line of the Build Mode plan — todo | doing | done.
struct BuildPlanItem: Hashable {
    let text: String
    var state: String
}

/// Architecture + todo checklist Build Mode drafts before coding, updated live as items finish.
struct BuildPlan: Hashable {
    var architecture: String
    var items: [BuildPlanItem]
}

struct BuildAskOption: Hashable {
    let label: String
    var description: String = ""
    var recommended: Bool = false
}

struct BuildAskQuestion: Identifiable, Hashable {
    let id: String
    let question: String
    var options: [BuildAskOption]
}

/// What Build Mode did for a message: its steps plus the live preview it produced (if any).
struct BuildInfo: Hashable {
    var plan: BuildPlan?
    var steps: [BuildStep] = []
    var previewUrl: String?
    var port: Int?
    var elapsedMs: Int?
    var zipBytes: Int?
    var zipName: String?
    var ask: [BuildAskQuestion]?
}

struct ChatMessage: Identifiable, Hashable {
    let id: String
    let role: Role
    var content: String = ""
    var thinkingSteps: [String] = []
    var thinkingLabel: String?
    var status: String?
    var sources: [Source] = []
    var reasoning: String = ""
    var canvasHtml: String?
    var isStreaming: Bool = false
    var attachments: [PendingAttachment] = []
    var modesUsed: Set<Mode> = []
    var agents: [AgentStatus] = []
    var build: BuildInfo?
}

struct ChatThread: Identifiable, Hashable {
    let id: String
    var title: String
    var messages: [ChatMessage] = []
    var updatedAt: Date = Date()
}

struct FridayUser: Hashable {
    var name: String
    var email: String
    var phone: String?
    var birthday: String?
    var instructions: String?
}

enum SheetState: Equatable {
    case none, auth, welcome, signup, model, attach, plugins
}

enum AuthStep {
    case form, otp
}

func placeholderFor(_ modes: Set<Mode>) -> String {
    if modes.contains(.canvas) { return "Create on canvas…" }
    if modes.contains(.think) { return "Think deeply…" }
    if modes.contains(.research) { return "What should I research?" }
    if modes.contains(.search) { return "Search the web…" }
    return "What do you want to know?"
}

func nameFromEmail(_ email: String) -> String {
    guard let local = email.split(separator: "@").first else { return "You" }
    let parts = local.split(whereSeparator: { $0 == "." || $0 == "_" || $0 == "-" })
    if parts.isEmpty { return "You" }
    return parts.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
}

func titleFrom(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    if trimmed.isEmpty { return "New chat" }
    if trimmed.count <= 42 { return trimmed }
    return String(trimmed.prefix(42)) + "…"
}

struct RemoteModel: Identifiable, Hashable {
    var id: String { modelId }
    let modelId: String
    let displayName: String
    let minTier: String?
    let providerSlug: String?
}
