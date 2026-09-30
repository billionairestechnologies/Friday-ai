import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct RootShell: View {
    @EnvironmentObject var vm: FridayViewModel

    var body: some View {
        ZStack {
            switch vm.page {
            case "settings": SettingsScreen()
            case "plans": PlansScreen()
            case "library": LibraryScreen()
            case "projects": StubPage(title: "Projects", body: "Project-scoped chats and files will live here.") { vm.page = "chat" }
            case "automations": AutomationsScreen()
            default: ChatShell()
            }
        }
        .fullScreenCover(isPresented: Binding(get: { vm.authRequired }, set: { vm.authRequired = $0 })) {
            AuthLanding()
        }
        .sheet(isPresented: Binding(get: { vm.sheet == .welcome || vm.sheet == .signup }, set: { if !$0 { vm.sheet = .none } })) {
            AuthFormSheet()
        }
        .fullScreenCover(isPresented: $vm.voiceModeOpen) {
            VoiceModeScreen()
        }
    }
}

private struct ChatShell: View {
    @EnvironmentObject var vm: FridayViewModel

    // Staggered entrance sequence, matching android FridayApp.kt: glow 400ms,
    // greeting fade+slide 500ms (80ms delay), composer fade+scale 480ms
    // (140ms delay), top bar fade 400ms (100ms delay).
    @State private var topBarIn = false
    @State private var greetingIn = false
    @State private var composerIn = false
    @State private var photoItem: PhotosPickerItem?
    @State private var triggerPhotosPicker = false
    @State private var triggerFilesPicker = false
    @State private var triggerCamera = false

    private var reduced: Bool { Motion.reduced }

    // Drawer follows the finger 1:1 and settles with a stiff spring — WhatsApp-style. A quarter
    // of the width, or any quick flick, commits it (the old code only reacted on finger-up, then
    // played a 0.3s ease-in-out, which is what made swiping feel slow).
    @State private var drawerX: CGFloat = -UIScreen.main.bounds.width
    @State private var drawerDragging = false
    private var screenW: CGFloat { UIScreen.main.bounds.width }
    private let settleSpring = Animation.spring(response: 0.26, dampingFraction: 0.88)

    private func settleDrawer(open: Bool) {
        drawerDragging = false
        vm.drawerOpen = open
        withAnimation(settleSpring) { drawerX = open ? 0 : -screenW }
    }

    private func trackDrawer(_ value: DragGesture.Value, startedOpen: Bool) {
        let dx = value.translation.width, dy = value.translation.height
        guard drawerDragging || (abs(dx) > 8 && abs(dx) > abs(dy) * 1.2) else { return }
        if !startedOpen && dx <= 0 && !drawerDragging { return }
        if startedOpen && dx >= 0 && !drawerDragging { return }
        drawerDragging = true
        let base: CGFloat = startedOpen ? 0 : -screenW
        drawerX = min(0, max(-screenW, base + dx))
    }

    private func finishDrawer(_ value: DragGesture.Value, startedOpen: Bool) {
        guard drawerDragging else { return }
        let revealed = (drawerX + screenW) / screenW
        let velocity = value.predictedEndTranslation.width - value.translation.width
        let open: Bool
        if abs(velocity) > 160 { open = velocity > 0 }
        else { open = startedOpen ? revealed > 0.75 : revealed > 0.25 }
        settleDrawer(open: open)
    }

    var body: some View {
        ZStack(alignment: .leading) {
                VStack(spacing: 0) {
                    topBar
                        .opacity(topBarIn ? 1 : 0)

                    if let update = vm.updateInfo {
                        Button {
                            if let url = URL(string: update.url) { UIApplication.shared.open(url) }
                        } label: {
                            Text("Update available — v\(update.version) is ready")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(.white)
                                .frame(maxWidth: .infinity).padding(.vertical, 6)
                                .background(LinearGradient(colors: [FridayColor.stop, FridayColor.search], startPoint: .leading, endPoint: .trailing))
                        }
                    }

                    ZStack {
                        if let chat = vm.currentChat, !chat.messages.isEmpty {
                            ChatThreadView(messages: chat.messages)
                        } else {
                            emptyState
                        }
                    }
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 10)
                            .onChanged { value in
                                if !vm.drawerOpen && !vm.canvasOpen { trackDrawer(value, startedOpen: false) }
                            }
                            .onEnded { value in
                                if drawerDragging { finishDrawer(value, startedOpen: false); return }
                                let dx = value.translation.width, dy = value.translation.height
                                if dy > 40 && abs(dy) > abs(dx) * 1.5 {
                                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                                    return
                                }
                                // Swipe up on the (non-scrolling) start screen brings up the keyboard.
                                if dy < -50 && abs(dy) > abs(dx) * 1.5 && (vm.currentChat?.messages.isEmpty ?? true) {
                                    vm.composerFocusTick += 1
                                    return
                                }
                                guard abs(dx) > abs(dy) * 1.5 else { return }
                                if dx < -60 && !vm.canvasOpen {
                                    withAnimation(settleSpring) { vm.canvasOpen = true }
                                }
                            }
                    )

                    if let pending = vm.pendingAsk {
                        BuildAskPanel(messageId: pending.messageId, questions: pending.questions)
                            .id(pending.messageId)
                            .padding(.horizontal, 12)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }

                    if vm.pendingPlanMessage != nil, !vm.isStreamingCurrent {
                        PlanApprovalBar()
                            .padding(.horizontal, 12)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }

                    ComposerBar()
                        .padding(.bottom, 8)
                        .opacity(composerIn ? 1 : 0)
                        .scaleEffect(composerIn ? 1 : 0.96)
                }
                .background(FridayColor.bg.ignoresSafeArea())

                if vm.drawerOpen || drawerDragging || drawerX > -screenW + 1 {
                    Color.black.opacity(0.001)
                        .ignoresSafeArea()
                        .onTapGesture { settleDrawer(open: false) }
                    DrawerPane()
                        .frame(maxWidth: .infinity)
                        .offset(x: drawerX)
                        .simultaneousGesture(
                            DragGesture(minimumDistance: 10)
                                .onChanged { value in trackDrawer(value, startedOpen: true) }
                                .onEnded { value in finishDrawer(value, startedOpen: true) }
                        )
                }

                if vm.canvasOpen {
                    HStack {
                        Spacer()
                        CanvasPanel()
                            .frame(width: UIScreen.main.bounds.width)
                            .transition(.move(edge: .trailing))
                            .shadow(radius: 12)
                            .simultaneousGesture(
                                DragGesture(minimumDistance: 25)
                                    .onEnded { value in
                                        let dx = value.translation.width, dy = value.translation.height
                                        if dx > 60 && abs(dx) > abs(dy) * 1.5 {
                                            withAnimation(settleSpring) { vm.canvasOpen = false }
                                        }
                                    }
                            )
                    }
                }

                if vm.sheet == .model {
                    AnchoredPopover(anchor: .bottomTrailing, widthFraction: 0.66, onDismiss: { vm.sheet = .none }) {
                        modelPopoverContent
                    }
                    .transition(.identity)
                }

                if vm.sheet == .attach {
                    AnchoredPopover(anchor: .bottomLeading, widthFraction: 0.62, onDismiss: { vm.sheet = .none }) {
                        attachPopoverContent
                    }
                    .transition(.identity)
                }
        }
        .sheet(isPresented: Binding(get: { vm.sheet == .plugins }, set: { if !$0 { vm.sheet = .none } })) {
            PluginsSheet()
        }
        .photosPicker(isPresented: $triggerPhotosPicker, selection: $photoItem, matching: .any(of: [.images]))
        .onChange(of: vm.drawerOpen) { open in
            if !drawerDragging { withAnimation(settleSpring) { drawerX = open ? 0 : -screenW } }
        }
        .onChange(of: photoItem) { item in
            guard let item else { return }
            Task { await loadPhoto(item) }
        }
        .fileImporter(
            isPresented: $triggerFilesPicker,
            allowedContentTypes: [.image, .pdf, .plainText, .json, .xml, .commaSeparatedText,
                                   UTType(filenameExtension: "docx") ?? .data,
                                   UTType(filenameExtension: "xlsx") ?? .data,
                                   UTType(filenameExtension: "md") ?? .plainText],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first { loadFile(url) }
        }
        .fullScreenCover(isPresented: $triggerCamera) {
            CameraCapture { image in
                triggerCamera = false
                guard let image else { return }
                loadCameraImage(image)
            }
            .ignoresSafeArea()
        }
        .onAppear { playEntrance() }
    }

    private func playEntrance() {
        guard !topBarIn else { return }
        if reduced {
            topBarIn = true; greetingIn = true; composerIn = true
            return
        }
        withAnimation(.easeInOut(duration: 0.4).delay(0.1)) { topBarIn = true }
        withAnimation(.easeInOut(duration: 0.5).delay(0.08)) { greetingIn = true }
        withAnimation(.easeInOut(duration: 0.48).delay(0.14)) { composerIn = true }
    }

    private var topBar: some View {
        HStack {
            Button { vm.drawerOpen = true } label: {
                Image(systemName: "line.3.horizontal").foregroundColor(FridayColor.text)
            }

            if vm.user == nil || (vm.planLoaded && vm.plan == "free") {
                Button {
                    if vm.user == nil { vm.startAuth(signup: false) } else { vm.page = "plans" }
                } label: {
                    Text(vm.user == nil ? "Log in" : "Upgrade")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14).padding(.vertical, 7)
                        .background(FridayColor.text)
                        .clipShape(Capsule())
                }
            }

            Spacer()
            Text("Friday").font(.system(size: 17, weight: .semibold)).foregroundColor(FridayColor.text)
            Spacer()

            Button { withAnimation(settleSpring) { vm.canvasOpen.toggle() } } label: {
                Image(systemName: "square.grid.2x2")
                    .foregroundColor(vm.canvasOpen ? FridayColor.canvas : FridayColor.text)
                    .padding(6)
                    .background(vm.canvasOpen ? FridayColor.canvas.opacity(0.12) : Color.clear)
                    .clipShape(Circle())
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 46)
        .padding(.top, -8)
    }

    private var emptyState: some View {
        VStack {
            Spacer()
            Text(vm.workspace == "build" ? "What should we build?" : greeting)
                .font(.system(size: 28, weight: .bold))
                .foregroundColor(FridayColor.text)
                .opacity(greetingIn ? 1 : 0)
                .offset(y: greetingIn ? 0 : 12)
            Spacer()
        }
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let name = (vm.user?.name.split(separator: " ").first).map(String.init) ?? ""
        let time: String
        switch hour {
        case 0..<5, 21...23: time = "Good night"
        case 5..<12: time = "Good morning"
        case 12..<17: time = "Good afternoon"
        default: time = "Good evening"
        }
        return name.isEmpty ? time : "\(time), \(name)"
    }

    // MARK: - Model popover (anchored bottom-trailing, matches android's model popup)

    private var modelPopoverContent: some View {
        VStack(spacing: 0) {
            PopoverRow(icon: "bolt.fill", title: "Auto", subtitle: "Tries enabled models in order, falls back automatically", selected: vm.selectedModelId == AUTO_MODEL_ID) {
                selectModel(AUTO_MODEL_ID)
            }
            Divider().padding(.leading, 52)
            PopoverRow(icon: "person.3.fill", title: "Team Up", subtitle: "Asks up to 3 models at once and shows every reply", selected: vm.selectedModelId == TEAMUP_MODEL_ID) {
                selectModel(TEAMUP_MODEL_ID)
            }
            if !vm.remoteModels.isEmpty {
                Divider().padding(.leading, 52)
            }
            ForEach(vm.remoteModels) { model in
                let locked = !ModelBrand.planSatisfies(vm.plan, minTier: model.minTier)
                PopoverRow(
                    icon: ModelBrand.systemIcon(for: model.modelId + " " + model.displayName),
                    title: ModelBrand.displayLabel(model.displayName),
                    subtitle: (model.minTier?.isEmpty == false ? model.minTier!.capitalized + " tier" : nil),
                    selected: vm.selectedModelId == model.modelId,
                    iconColor: ModelBrand.color(for: model.modelId + " " + model.displayName),
                    locked: locked,
                    logoKey: model.modelId + " " + model.displayName
                ) {
                    if locked {
                        vm.sheet = .none
                        vm.page = "plans"
                    } else {
                        selectModel(model.modelId)
                    }
                }
                if model.id != vm.remoteModels.last?.id {
                    Divider().padding(.leading, 52)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private func selectModel(_ id: String) {
        vm.selectedModelId = id
        vm.sheet = .none
    }

    // MARK: - Attach popover (anchored bottom-leading, matches android's attach popup)

    private var attachPopoverContent: some View {
        VStack(spacing: 0) {
            PopoverRow(icon: "camera.fill", title: "Camera", subtitle: nil, circularIcon: true) {
                vm.sheet = .none
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { triggerCamera = true }
            }
            PopoverRow(icon: "photo.on.rectangle", title: "Photos", subtitle: nil, circularIcon: true) {
                vm.sheet = .none
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { triggerPhotosPicker = true }
            }
            PopoverRow(icon: "doc.fill", title: "Files", subtitle: nil, circularIcon: true) {
                vm.sheet = .none
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { triggerFilesPicker = true }
            }
            // Deep Research on/off for the next message — same place as the web's "+" menu.
            PopoverRow(icon: "binoculars.fill", title: "Deep research", subtitle: nil, selected: vm.modes.contains(.research), circularIcon: true) {
                vm.toggleMode(.research)
                vm.sheet = .none
            }
            PopoverRow(icon: "puzzlepiece.extension.fill", title: "Plugins", subtitle: nil, circularIcon: true) {
                vm.sheet = .plugins
            }
        }
        .padding(.vertical, 6)
    }

    private func loadPhoto(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let mime = "image/jpeg"
        let b64 = data.base64EncodedString()
        let attachment = PendingAttachment(
            id: UUID().uuidString, name: "photo.jpg", mime: mime, size: data.count, kind: "image",
            dataUrl: "data:\(mime);base64,\(b64)"
        )
        await MainActor.run {
            vm.addAttachment(attachment)
            photoItem = nil
        }
    }

    private func loadFile(_ url: URL) {
        guard url.startAccessingSecurityScopedResource() else { return }
        defer { url.stopAccessingSecurityScopedResource() }
        guard let data = try? Data(contentsOf: url) else { return }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let kind = mime.hasPrefix("image/") ? "image" : "file"
        let b64 = data.base64EncodedString()
        let attachment = PendingAttachment(
            id: UUID().uuidString, name: url.lastPathComponent, mime: mime, size: data.count, kind: kind,
            dataUrl: "data:\(mime);base64,\(b64)"
        )
        vm.addAttachment(attachment)
    }

    private func loadCameraImage(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.85) else { return }
        let mime = "image/jpeg"
        let b64 = data.base64EncodedString()
        let attachment = PendingAttachment(
            id: UUID().uuidString, name: "camera.jpg", mime: mime, size: data.count, kind: "image",
            dataUrl: "data:\(mime);base64,\(b64)"
        )
        vm.addAttachment(attachment)
    }
}

private struct CameraCapture: UIViewControllerRepresentable {
    let onCapture: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCapture: onCapture) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (UIImage?) -> Void
        init(onCapture: @escaping (UIImage?) -> Void) { self.onCapture = onCapture }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onCapture(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCapture(nil)
        }
    }
}

private struct StubPage: View {
    let title: String
    let body_: String
    let onClose: () -> Void

    init(title: String, body: String, onClose: @escaping () -> Void) {
        self.title = title
        self.body_ = body
        self.onClose = onClose
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title).font(.system(size: 22, weight: .medium)).foregroundColor(FridayColor.text)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark").foregroundColor(FridayColor.text).padding(8)
                }
            }
            Text(body_).font(.system(size: 15)).foregroundColor(FridayColor.muted)
            Spacer()
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(FridayColor.bg.ignoresSafeArea())
    }
}

private struct PluginsSheet: View {
    var body: some View {
        List {
            Section("Connectors") {
                Label("Gmail", systemImage: "envelope")
                Label("Calendar", systemImage: "calendar")
                Label("Drive", systemImage: "folder")
                Label("GitHub", systemImage: "chevron.left.slash.chevron.right")
            }
            Section("Skills") {
                Label("Web Search", systemImage: "globe")
                Label("Think", systemImage: "gearshape")
                Label("Canvas", systemImage: "rectangle.split.2x1")
            }
        }
    }
}
