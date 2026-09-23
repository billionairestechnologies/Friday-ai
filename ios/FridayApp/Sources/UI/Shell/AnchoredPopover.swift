import SwiftUI

/// Scrim + rounded card anchored to a screen corner above the composer —
/// matches android's Model/Attach popups (NOT a full bottom sheet; those are
/// small anchored popovers, see FridayApp.kt / ComposerBar.kt).
struct AnchoredPopover<Content: View>: View {
    enum Anchor { case bottomLeading, bottomTrailing }

    let anchor: Anchor
    let widthFraction: CGFloat
    let onDismiss: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var appeared = false

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: anchor == .bottomTrailing ? .bottomTrailing : .bottomLeading) {
                FridayColor.scrim
                    .ignoresSafeArea()
                    .opacity(appeared ? 1 : 0)
                    .onTapGesture { dismiss() }

                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        content()
                    }
                }
                .frame(width: geo.size.width * widthFraction)
                .frame(maxHeight: min(geo.size.height * 0.5, 420), alignment: .top)
                .fixedSize(horizontal: false, vertical: true)
                .background(FridayColor.bg)
                .cornerRadius(FridayRadius.sheet)
                .shadow(color: .black.opacity(0.2), radius: 20, x: 0, y: 8)
                .padding(.horizontal, 16)
                .padding(.bottom, 116)
                .scaleEffect(appeared ? 1 : 0.92, anchor: anchor == .bottomTrailing ? .bottomTrailing : .bottomLeading)
                .opacity(appeared ? 1 : 0)
            }
        }
        .onAppear {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) { appeared = true }
        }
    }

    private func dismiss() {
        withAnimation(.easeIn(duration: 0.15)) { appeared = false }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { onDismiss() }
    }
}

struct PopoverRow: View {
    let icon: String
    let title: String
    let subtitle: String?
    var selected: Bool = false
    var circularIcon: Bool = false
    var iconColor: Color = FridayColor.canvas
    /// Model is above the user's plan tier — shown dimmed with a lock, tapping routes to upgrade
    /// instead of selecting it (mirrors backend's planSatisfiesTier gate in tokenQuotaService.ts).
    var locked: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: subtitle == nil ? .center : .top, spacing: 14) {
                if circularIcon {
                    Image(systemName: icon)
                        .font(.system(size: 16))
                        .foregroundColor(FridayColor.text)
                        .frame(width: 40, height: 40)
                        .background(FridayColor.surface)
                        .clipShape(Circle())
                } else {
                    Image(systemName: icon)
                        .font(.system(size: 17))
                        .foregroundColor(locked ? FridayColor.muted : iconColor)
                        .frame(width: 22)
                        .padding(.top, subtitle == nil ? 0 : 2)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundColor(locked ? FridayColor.muted : FridayColor.text)
                    if let subtitle {
                        Text(subtitle)
                            .font(.system(size: 12.5))
                            .foregroundColor(FridayColor.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if locked {
                    Image(systemName: "lock.fill").font(.system(size: 13)).foregroundColor(FridayColor.muted)
                } else if selected {
                    Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundColor(FridayColor.text)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(selected ? FridayColor.surface : Color.clear)
            .opacity(locked ? 0.55 : 1)
        }
        .buttonStyle(.plain)
    }
}
