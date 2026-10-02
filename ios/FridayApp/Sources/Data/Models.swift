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
    /// File steps: which file, and the change itself (code for a new file, "- "/"+ " lines for an edit).
    var path: String?
    var code: String?
    var added: Int?
    var removed: Int?
    /// kind "agent": a Build / Deep Research sub-agent — its job, its own live actions and its report.
    var agent: SubAgentInfo?

    /// A step from the stream or a saved message — shared so both keep the file-change fields.
    static func parse(_ j: [String: Any], defaultState: String) -> BuildStep {
        BuildStep(
            id: j["id"] as? String ?? UUID().uuidString,
            kind: j["kind"] as? String ?? "run",
            label: j["label"] as? String ?? "",
            state: j["state"] as? String ?? defaultState,
            detail: j["detail"] as? String,
            path: j["path"] as? String,
            code: j["code"] as? String,
            added: j["added"] as? Int,
            removed: j["removed"] as? Int,
            agent: (j["agent"] as? [String: Any]).map(SubAgentInfo.parse)
        )
    }
}

/// A parallel helper the agent handed work to (backend projectBuild/subagents.ts): `kind` is explore | research.
struct SubAgentInfo: Hashable {
    struct Action: Identifiable, Hashable {
        let id: String
        let label: String
        let state: String // running | ok | error
    }
    let title: String
    let kind: String
    var actions: [Action]
    var report: String?

    static func parse(_ j: [String: Any]) -> SubAgentInfo {
        let actions = (j["actions"] as? [[String: Any]] ?? []).map {
            Action(id: $0["id"] as? String ?? UUID().uuidString, label: $0["label"] as? String ?? "", state: $0["state"] as? String ?? "running")
        }
        return SubAgentInfo(title: j["title"] as? String ?? "", kind: j["kind"] as? String ?? "explore", actions: actions, report: j["report"] as? String)
    }
}

/// A Build permission prompt (backend projectBuild/approvals.ts). kind: file | command | connector | pr;
/// state: pending | allowed | denied. `always` = asks even in Full auto.
struct BuildApproval: Identifiable, Hashable {
    let id: String
    let kind: String
    let title: String
    let detail: String?
    let always: Bool
    var state: String

    static func parse(_ j: [String: Any], defaultState: String = "pending") -> BuildApproval {
        BuildApproval(
            id: j["id"] as? String ?? UUID().uuidString,
            kind: j["kind"] as? String ?? "command",
            title: j["title"] as? String ?? "",
            detail: (j["detail"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            always: j["always"] as? Bool ?? false,
            state: j["state"] as? String ?? defaultState
        )
    }
}

/// One row of the Build home / drawer (backend GET /api/build/sessions).
/// status: running | needs_input | done | error | idle.
struct BuildSessionSummary: Identifiable, Hashable {
    let id: String
    let title: String
    let updatedAt: Date?
    let status: String
    let activity: String
    let repo: String?
    let prUrl: String?
}

/// One line of the Build Mode plan — todo | doing | done.
struct BuildPlanItem: Hashable {
    let text: String
    var state: String
}

/// Architecture + todo checklist Build Mode drafts before coding, updated live as items finish.
/// `summary` = plain-language "what I'll build"; `status` = the approval round: "pending" (waiting
/// for approve / changes), "approved", "revised" (replaced by a newer plan); nil on older plans.
struct BuildPlan: Hashable {
    var architecture: String
    var items: [BuildPlanItem]
    var summary: String?
    var status: String?

    static func parse(_ p: [String: Any]?) -> BuildPlan? {
        guard let p else { return nil }
        let items = (p["items"] as? [[String: Any]] ?? []).map { BuildPlanItem(text: $0["text"] as? String ?? "", state: $0["state"] as? String ?? "todo") }
        let summary = (p["summary"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let status = (p["status"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return BuildPlan(architecture: p["architecture"] as? String ?? "", items: items, summary: summary, status: status)
    }
}

/// The server stores a plan message as this line + the plan text; the thread shows only the card.
let planMarker = "Here's the plan. Approve it to start building, or tell me what to change."
/// The Approve button sends exactly this (backend plan.ts keys off it).
let planApproveText = "Approved — build it as planned."

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
    /// The local stream dropped mid-reply (network blip, app backgrounded/killed) rather than a
    /// clean server "done" — content here may be incomplete or stale. Cleared by whatever refetches
    /// the real, server-persisted reply (see FridayViewModel.onAppForegrounded/selectChat).
    var disconnected: Bool = false
    var attachments: [PendingAttachment] = []
    var modesUsed: Set<Mode> = []
    var agents: [AgentStatus] = []
    var build: BuildInfo?
    /// Normal chat answered a build request — shows "Open in Build" carrying this prompt.
    var suggestBuildPrompt: String?
}

struct ChatThread: Identifiable, Hashable {
    let id: String
    var title: String
    var messages: [ChatMessage] = []
    var updatedAt: Date = Date()
    /// "build" = a Build workspace session (listed under Build; every message goes to the Build agent).
    var workspace: String?
    /// Build Mode made a project here (from before Build moved to its own tab) — also listed under Build.
    var hasBuild: Bool = false

    var isBuild: Bool { workspace == "build" || hasBuild }
}

struct FridayUser: Hashable {
    /// Supabase auth.users.id — required for the Realtime `user_id=eq.<id>` filter. Empty for the
    /// optimistic cached-identity placeholder set before /auth/me resolves (see FridayViewModel.bootstrap).
    var id: String = ""
    var name: String
    var email: String
    var phone: String?
    var birthday: String?
    var instructions: String?
    /// The Privacy Policy/Terms version this account last agreed to — compared against
    /// FridayViewModel.policyVersion to decide whether to show the blocking "I agree" gate.
    var policyVersion: String?
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
    /// Offered in the Build workspace's picker (frontier coding models only).
    var build: Bool = false
}
