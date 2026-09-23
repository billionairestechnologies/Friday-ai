import SwiftUI
import AuthenticationServices

struct AuthFormSheet: View {
    @EnvironmentObject var vm: FridayViewModel
    @Environment(\.dismiss) var dismiss

    @State private var name = ""
    @State private var phone = ""
    @State private var birthday = ""
    @State private var email = ""
    @State private var password = ""
    @State private var otp = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").frame(width: 32, height: 32).background(FridayColor.surface).clipShape(Circle())
                    }
                }

                if vm.authStep == .form {
                    formBody
                } else {
                    otpBody
                }
            }
            .padding(20)
        }
        .foregroundColor(FridayColor.text)
    }

    @ViewBuilder
    private var formBody: some View {
        Text(vm.isSignupFlow ? "Create your account" : "Welcome back")
            .font(.system(size: 22, weight: .medium))
        Text(vm.isSignupFlow ? "Smarter replies, files, Canvas history, sync across devices." : "Pick up where you left off.")
            .font(.system(size: 14)).foregroundColor(FridayColor.muted)

        if vm.isSignupFlow {
            field("Name", text: $name)
            field("Mobile number", text: $phone, keyboard: .phonePad)
            field("Birthday (YYYY-MM-DD)", text: $birthday, keyboard: .numbersAndPunctuation)
        }
        field("Email address", text: $email, keyboard: .emailAddress)
        field("Password", text: $password, secure: true)

        if let error = vm.authError {
            Text(error).font(.system(size: 13)).foregroundColor(FridayColor.error)
        }

        Button {
            Task { await vm.submitCredentials(name: name, email: email, password: password, phone: phone, birthday: birthday) }
        } label: {
            Text(vm.authBusy ? "Please wait…" : "Continue")
                .font(.system(size: 15, weight: .semibold))
                .frame(maxWidth: .infinity).frame(height: 48)
                .foregroundColor(FridayColor.bg)
                .background(FridayColor.text.opacity(vm.authBusy ? 0.55 : 1))
                .cornerRadius(24)
        }
        .disabled(vm.authBusy)

        HStack {
            Rectangle().fill(FridayColor.hairline).frame(height: 1)
            Text("OR").font(.system(size: 12)).foregroundColor(FridayColor.muted)
            Rectangle().fill(FridayColor.hairline).frame(height: 1)
        }

        outlinedButton("Continue with Google", icon: AnyView(GoogleLogo(size: 18))) {
            Task { await OAuthLauncher.start(.google, vm: vm) }
        }
        outlinedButton("Continue with GitHub", icon: AnyView(GitHubLogo(size: 18))) {
            Task { await OAuthLauncher.start(.github, vm: vm) }
        }

        Button {
            vm.authError = nil
            vm.isSignupFlow.toggle()
        } label: {
            HStack(spacing: 4) {
                Text(vm.isSignupFlow ? "Already have an account?" : "Don't have an account?")
                    .foregroundColor(FridayColor.muted)
                Text(vm.isSignupFlow ? "Log in" : "Sign up")
                    .fontWeight(.semibold)
                    .foregroundColor(FridayColor.text)
            }
            .font(.system(size: 13))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var otpBody: some View {
        Text("Check your email").font(.system(size: 22, weight: .medium))
        Text("We sent a 6-digit code to \(vm.authEmail)").font(.system(size: 14)).foregroundColor(FridayColor.muted)

        TextField("", text: $otp)
            .keyboardType(.numberPad)
            .font(.system(size: 20))
            .tracking(6)
            .multilineTextAlignment(.center)
            .padding(14)
            .background(FridayColor.surface)
            .cornerRadius(16)
            .onChange(of: otp) { newValue in
                if newValue.count > 6 { otp = String(newValue.prefix(6)) }
                otp = otp.filter(\.isNumber)
            }

        if let error = vm.authError {
            Text(error).font(.system(size: 13)).foregroundColor(FridayColor.error)
        }

        Button {
            Task { await vm.verifyOtp(code: otp) }
        } label: {
            Text("Verify")
                .font(.system(size: 15, weight: .semibold))
                .frame(maxWidth: .infinity).frame(height: 48)
                .foregroundColor(FridayColor.bg)
                .background(FridayColor.text.opacity(otp.count == 6 ? 1 : 0.4))
                .cornerRadius(24)
        }
        .disabled(otp.count != 6 || vm.authBusy)

        Button { Task { await vm.resendOtp() } } label: {
            Text("Didn't get it? Resend code").font(.system(size: 13)).foregroundColor(FridayColor.muted)
        }
        .frame(maxWidth: .infinity)

        Button {
            otp = ""
            vm.authError = nil
            vm.authStep = .form
        } label: {
            Text("Use a different email").font(.system(size: 13)).foregroundColor(FridayColor.muted)
        }
        .frame(maxWidth: .infinity)
    }

    private func field(_ placeholder: String, text: Binding<String>, secure: Bool = false, keyboard: UIKeyboardType = .default) -> some View {
        Group {
            if secure {
                SecureField(placeholder, text: text)
            } else {
                TextField(placeholder, text: text).keyboardType(keyboard).autocapitalization(.none)
            }
        }
        .font(.system(size: 15))
        .padding(14)
        .background(FridayColor.surface)
        .cornerRadius(16)
    }

    private func outlinedButton(_ title: String, icon: AnyView, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                icon
                Text(title).font(.system(size: 14, weight: .medium))
            }
            .frame(maxWidth: .infinity).frame(height: 48)
            .foregroundColor(FridayColor.text)
            .overlay(RoundedRectangle(cornerRadius: 24).stroke(FridayColor.hairline, lineWidth: 1))
        }
    }
}


// MARK: - OAuth

@MainActor
enum OAuthLauncher {
    enum Provider { case google, github }
    private static var session: ASWebAuthenticationSession?

    static func start(_ provider: Provider, vm: FridayViewModel) async {
        vm.authError = nil
        do {
            let url = provider == .google ? try await AuthApi.googleStartURL() : try await AuthApi.githubStartURL()
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "com.friday.app.ios") { callbackURL, error in
                Task { @MainActor in
                    if let fragment = callbackURL?.fragment {
                        await vm.completeOAuth(fragment: fragment)
                    } else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                        return
                    } else {
                        vm.authError = "Sign-in didn't complete. Please try again."
                    }
                }
            }
            s.presentationContextProvider = OAuthPresentationContext.shared
            session = s
            if !s.start() { vm.authError = "Couldn't open the sign-in page. Please try again." }
        } catch {
            vm.authError = "Couldn't start sign-in: \(error.localizedDescription)"
        }
    }
}

// MARK: - Brand logos (paths ported from android res/drawable/ic_google.xml + ic_github.xml)

struct SVGPathShape: Shape {
    let d: String
    let viewport: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = SVGPathParser.parse(d)
        let scale = min(rect.width, rect.height) / viewport
        path = path.applying(CGAffineTransform(scaleX: scale, y: scale))
        return path
    }
}

enum SVGPathParser {
    static func parse(_ d: String) -> Path {
        var tokens: [String] = []
        var num = ""
        func flush() { if !num.isEmpty { tokens.append(num); num = "" } }
        for ch in d {
            if ch.isLetter && ch != "e" && ch != "E" {
                flush(); tokens.append(String(ch))
            } else if ch == "-" {
                if !num.isEmpty && !(num.last == "e" || num.last == "E") { flush() }
                num.append(ch)
            } else if ch == "." {
                if num.contains(".") { flush() }
                num.append(ch)
            } else if ch == "," || ch == " " || ch == "\n" {
                flush()
            } else {
                num.append(ch)
            }
        }
        flush()

        var path = Path()
        var i = 0
        var cmd: Character = "M"
        var cur = CGPoint.zero, start = CGPoint.zero
        var lastCtrl: CGPoint?
        func next() -> CGFloat { defer { i += 1 }; return CGFloat(Double(tokens[i]) ?? 0) }
        while i < tokens.count {
            if let c = tokens[i].first, c.isLetter { cmd = c; i += 1 }
            let rel = cmd.isLowercase
            switch cmd {
            case "M", "m":
                let x = next(), y = next()
                cur = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                start = cur; path.move(to: cur); cmd = rel ? "l" : "L"; lastCtrl = nil
            case "L", "l":
                let x = next(), y = next()
                cur = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                path.addLine(to: cur); lastCtrl = nil
            case "H", "h":
                let x = next(); cur.x = rel ? cur.x + x : x; path.addLine(to: cur); lastCtrl = nil
            case "V", "v":
                let y = next(); cur.y = rel ? cur.y + y : y; path.addLine(to: cur); lastCtrl = nil
            case "C", "c":
                let x1 = next(), y1 = next(), x2 = next(), y2 = next(), x = next(), y = next()
                let o = rel ? cur : .zero
                let c1 = CGPoint(x: o.x + x1, y: o.y + y1), c2 = CGPoint(x: o.x + x2, y: o.y + y2)
                cur = CGPoint(x: o.x + x, y: o.y + y)
                path.addCurve(to: cur, control1: c1, control2: c2); lastCtrl = c2
            case "S", "s":
                let x2 = next(), y2 = next(), x = next(), y = next()
                let o = rel ? cur : .zero
                let c1 = lastCtrl.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let c2 = CGPoint(x: o.x + x2, y: o.y + y2)
                cur = CGPoint(x: o.x + x, y: o.y + y)
                path.addCurve(to: cur, control1: c1, control2: c2); lastCtrl = c2
            case "Z", "z":
                path.closeSubpath(); cur = start; lastCtrl = nil
            default:
                i += 1
            }
        }
        return path
    }
}

struct GoogleLogo: View {
    var size: CGFloat = 18
    private static let parts: [(String, UInt32)] = [
        ("M17.64,9.2045c0,-0.6381 -0.0573,-1.2518 -0.1636,-1.8409H9v3.4814h4.8436c-0.2086,1.125 -0.8427,2.0782 -1.7959,2.7164v2.2581h2.9087c1.7018,-1.5668 2.6836,-3.874 2.6836,-6.615z", 0x4285F4),
        ("M9,18c2.43,0 4.4673,-0.806 5.9564,-2.1805l-2.9087,-2.2581c-0.8059,0.5401 -1.8368,0.8591 -3.0477,0.8591 -2.3436,0 -4.3282,-1.5831 -5.0359,-3.7104H0.9573v2.3318C2.4382,15.9832 5.4818,18 9,18z", 0x34A853),
        ("M3.9641,10.71c-0.18,-0.5401 -0.2822,-1.1168 -0.2822,-1.71s0.1023,-1.1699 0.2822,-1.71V4.9582H0.9573C0.3477,6.1732 0,7.5477 0,9s0.3477,2.8268 0.9573,4.0418L3.9641,10.71z", 0xFBBC05),
        ("M9,3.5795c1.3214,0 2.5077,0.4541 3.4405,1.346l2.5813,-2.5814C13.4632,0.8918 11.43,0 9,0 5.4818,0 2.4382,2.0168 0.9573,4.9582L3.9641,7.29C4.6718,5.1627 6.6564,3.5795 9,3.5795z", 0xEA4335),
    ]

    var body: some View {
        ZStack {
            ForEach(0..<Self.parts.count, id: \.self) { i in
                SVGPathShape(d: Self.parts[i].0, viewport: 18).fill(Color(hex: Self.parts[i].1))
            }
        }
        .frame(width: size, height: size)
    }
}

struct GitHubLogo: View {
    var size: CGFloat = 18
    private static let d = "M12,0.297c-6.63,0 -12,5.373 -12,12 0,5.303 3.438,9.8 8.205,11.385 0.6,0.113 0.82,-0.258 0.82,-0.577 0,-0.285 -0.01,-1.04 -0.015,-2.04 -3.338,0.724 -4.042,-1.61 -4.042,-1.61C4.422,18.07 3.633,17.7 3.633,17.7c-1.087,-0.744 0.084,-0.729 0.084,-0.729 1.205,0.084 1.838,1.236 1.838,1.236 1.07,1.835 2.809,1.305 3.495,0.998 0.108,-0.776 0.417,-1.305 0.76,-1.605 -2.665,-0.3 -5.466,-1.332 -5.466,-5.93 0,-1.31 0.465,-2.38 1.235,-3.22 -0.135,-0.303 -0.54,-1.523 0.105,-3.176 0,0 1.005,-0.322 3.3,1.23 0.955,-0.266 1.98,-0.399 3,-0.405 1.02,0.006 2.045,0.139 3.005,0.405 2.29,-1.552 3.295,-1.23 3.295,-1.23 0.645,1.653 0.24,2.873 0.12,3.176 0.765,0.84 1.23,1.91 1.23,3.22 0,4.61 -2.805,5.625 -5.475,5.92 0.42,0.36 0.81,1.096 0.81,2.22 0,1.606 -0.015,2.896 -0.015,3.286 0,0.32 0.21,0.694 0.825,0.576C20.565,22.092 24,17.592 24,12.297c0,-6.627 -5.373,-12 -12,-12"

    var body: some View {
        SVGPathShape(d: Self.d, viewport: 24)
            .fill(Color.primary, style: FillStyle(eoFill: false))
            .frame(width: size, height: size)
    }
}
