import SwiftUI
import UniformTypeIdentifiers

/// Projects: a project keeps its own instructions and a knowledge base of files that every chat inside it can
/// search (web parity: routes/projects.tsx + components/project-files.tsx).
struct ProjectsScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var projects: [ProjectSummary]?
    @State private var failed = false
    @State private var creating = false
    @State private var openProject: ProjectSummary?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Projects").font(.system(size: 22, weight: .medium)).foregroundColor(FridayColor.text)
                        Text("Instructions and files every chat in a project can use").font(.system(size: 13)).foregroundColor(FridayColor.muted)
                    }
                    Spacer()
                    Button { creating = true } label: { Image(systemName: "plus").foregroundColor(FridayColor.text).padding(8) }
                    Button { vm.page = "chat" } label: { Image(systemName: "xmark").foregroundColor(FridayColor.text).padding(8) }
                }
                .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 8)

                if let projects {
                    if projects.isEmpty {
                        Text("No projects yet. Tap + to create one, then add files for Friday to search.")
                            .font(.system(size: 14)).foregroundColor(FridayColor.muted).padding(20)
                    } else {
                        ScrollView {
                            VStack(spacing: 10) {
                                ForEach(projects) { p in
                                    Button { openProject = p } label: {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(p.name).font(.system(size: 16, weight: .medium)).foregroundColor(FridayColor.text)
                                            if !p.description.isEmpty {
                                                Text(p.description).font(.system(size: 13)).foregroundColor(FridayColor.muted).lineLimit(2)
                                            }
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(14)
                                        .background(FridayColor.surface)
                                        .cornerRadius(14)
                                    }
                                }
                            }
                            .padding(.horizontal, 16).padding(.bottom, 24)
                        }
                    }
                } else if failed {
                    Button("Couldn't load projects — tap to retry") { Task { await load() } }
                        .font(.system(size: 14)).foregroundColor(FridayColor.muted).padding(20)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                }
                Spacer(minLength: 0)
            }
            .background(FridayColor.bg.ignoresSafeArea())
            // iOS 16 target: navigationDestination(item:) is iOS 17+, so drive it with a Bool binding.
            .navigationDestination(isPresented: Binding(get: { openProject != nil }, set: { if !$0 { openProject = nil } })) {
                if let p = openProject { ProjectDetailScreen(project: p) { Task { await load() } } }
            }
        }
        .task {
            await load()
            // Coming from the drawer's Projects dropdown: open that project / the create form straight away.
            if let id = vm.projectToOpen { openProject = projects?.first(where: { $0.id == id }); vm.projectToOpen = nil }
            if vm.projectsCreateRequested { creating = true; vm.projectsCreateRequested = false }
        }
        .sheet(isPresented: $creating) {
            NewProjectSheet { Task { await load() } }
        }
    }

    private func load() async {
        do {
            projects = try await ProjectsApi.list()
            failed = false
        } catch {
            if projects == nil { failed = true }
        }
    }
}

private struct NewProjectSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCreated: () -> Void
    @State private var name = ""
    @State private var description = ""
    @State private var instructions = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") { TextField("e.g. Q4 launch", text: $name) }
                Section("What is it? (optional)") { TextField("Short description", text: $description) }
                Section("Instructions for Friday (optional)") { TextEditor(text: $instructions).frame(minHeight: 90) }
                if let error { Text(error).foregroundColor(FridayColor.error).font(.system(size: 13)) }
            }
            .navigationTitle("New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Creating…" : "Create") { Task { await save() } }
                        .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            _ = try await ProjectsApi.create(name: name.trimmingCharacters(in: .whitespaces), description: description, instructions: instructions)
            onCreated()
            dismiss()
        } catch {
            self.error = "Couldn't create the project. Try again."
        }
    }
}

private struct ProjectDetailScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    let project: ProjectSummary
    let onChanged: () -> Void
    @State private var files: [ProjectFile]?
    @State private var chats: [ConversationsApi.Summary] = []
    @State private var importing = false
    @State private var uploading = false
    @State private var error: String?
    @State private var confirmDelete = false
    @Environment(\.dismiss) private var dismiss

    private func size(_ bytes: Int) -> String {
        bytes < 1024 ? "\(bytes) B" : bytes < 1_048_576 ? String(format: "%.0f KB", Double(bytes) / 1024) : String(format: "%.1f MB", Double(bytes) / 1_048_576)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !project.instructions.isEmpty {
                    Text(project.instructions).font(.system(size: 14)).foregroundColor(FridayColor.muted)
                }

                Button {
                    vm.startProjectChat(project.id)
                } label: {
                    Label("New chat in this project", systemImage: "bubble.left")
                        .font(.system(size: 14.5, weight: .medium)).foregroundColor(FridayColor.bg)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(FridayColor.text).clipShape(Capsule())
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Knowledge files").font(.system(size: 15, weight: .semibold)).foregroundColor(FridayColor.text)
                        Spacer()
                        Button { importing = true } label: {
                            Label(uploading ? "Uploading…" : "Add files", systemImage: "plus").font(.system(size: 13.5))
                        }
                        .disabled(uploading)
                    }
                    Text("Friday reads and indexes these; every chat in the project searches them for relevant passages.")
                        .font(.system(size: 12.5)).foregroundColor(FridayColor.muted)
                    if let error { Text(error).font(.system(size: 12.5)).foregroundColor(FridayColor.error) }
                    if let files {
                        if files.isEmpty {
                            Text("No files yet.").font(.system(size: 13.5)).foregroundColor(FridayColor.muted).padding(.vertical, 6)
                        }
                        ForEach(files) { f in
                            HStack(spacing: 10) {
                                Image(systemName: "doc.text").foregroundColor(FridayColor.muted)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(f.filename).font(.system(size: 14)).foregroundColor(FridayColor.text).lineLimit(1)
                                    Text(f.status == "processing" ? "Reading and indexing…" : f.status == "error" ? (f.error ?? "Couldn't read this file") : "\(size(f.sizeBytes)) · \(f.chunkCount) passages\(f.embedded ? "" : " · keyword search")")
                                        .font(.system(size: 11.5)).foregroundColor(f.status == "error" ? FridayColor.error : FridayColor.muted)
                                }
                                Spacer()
                                if f.status == "processing" { ProgressView().scaleEffect(0.7) }
                                Button { Task { await remove(f) } } label: { Image(systemName: "trash").foregroundColor(FridayColor.muted) }
                            }
                            .padding(.vertical, 6)
                        }
                    } else {
                        ProgressView()
                    }
                }

                if !chats.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Chats in this project").font(.system(size: 15, weight: .semibold)).foregroundColor(FridayColor.text)
                        ForEach(chats) { c in
                            Button { vm.openProjectChat(c) } label: {
                                Text(c.title).font(.system(size: 14)).foregroundColor(FridayColor.text).lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                                    .background(FridayColor.surface).cornerRadius(12)
                            }
                        }
                    }
                }

                Button(role: .destructive) { confirmDelete = true } label: {
                    Text("Delete project").font(.system(size: 14)).foregroundColor(FridayColor.error)
                }
                .padding(.top, 8)
            }
            .padding(20)
        }
        .background(FridayColor.bg.ignoresSafeArea())
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await refresh() }
        .task {
            // Files are read in the background: poll while any is still processing.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if files?.contains(where: { $0.status == "processing" }) == true { await refresh() }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await upload(urls) } }
        }
        .confirmationDialog("Delete \"\(project.name)\" and its files?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete project", role: .destructive) {
                Task {
                    try? await ProjectsApi.delete(id: project.id)
                    onChanged()
                    dismiss()
                }
            }
        }
    }

    private func refresh() async {
        if let f = try? await ProjectsApi.files(projectId: project.id) { files = f } else if files == nil { files = [] }
        if let c = try? await ProjectsApi.conversations(projectId: project.id) { chats = c }
    }

    private func upload(_ urls: [URL]) async {
        uploading = true
        error = nil
        defer { uploading = false }
        for url in urls {
            do { try await ProjectsApi.upload(projectId: project.id, fileURL: url) }
            catch ApiError.http(_, let msg) { error = msg }
            catch { self.error = "Couldn't upload \(url.lastPathComponent)." }
        }
        await refresh()
    }

    private func remove(_ f: ProjectFile) async {
        try? await ProjectsApi.deleteFile(projectId: project.id, fileId: f.id)
        await refresh()
    }
}
