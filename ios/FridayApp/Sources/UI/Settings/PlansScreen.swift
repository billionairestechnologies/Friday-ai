import SwiftUI

struct PlanTier {
    let name: String
    let priceMonthly: Int
    let features: [String]
    let models: [String]
}

let individualTiers: [PlanTier] = [
    PlanTier(name: "Free", priceMonthly: 0, features: [
        "250,000 tokens/week", "50,000 tokens per 5-hour burst", "Lightweight models", "Chat, Search, Canvas preview",
    ], models: ["Claude Sonnet 5", "GPT-5.4 mini", "GPT-5.5", "NVIDIA: Nemotron 3 Super", "Sarvam 105B", "Z.ai: GLM 5.2"]),
    PlanTier(name: "Pro", priceMonthly: 999, features: [
        "Everything in Free", "2.5M tokens/week (10M/month)", "500,000 tokens per 5-hour burst", "Flagship models unlocked", "Higher concurrency",
    ], models: ["Claude Opus 5", "GPT-5.6 Luna", "GPT-5.6 Sol", "GPT-5.6 Terra"]),
    PlanTier(name: "Premium", priceMonthly: 1999, features: [
        "Everything in Pro", "6.25M tokens/week (25M/month)", "1.2M tokens per 5-hour burst", "Reasoning & heavy models unlocked", "Highest concurrency",
    ], models: ["Claude Fable 5", "Fable 5.1", "GPT-6 astra"]),
]

struct PlansScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var annual = false
    @State private var purchasing: String?
    @State private var statusMessage: String?
    @State private var statusIsError = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                HStack {
                    Spacer()
                    Button { vm.page = "chat" } label: {
                        Image(systemName: "xmark").foregroundColor(.white).frame(width: 32, height: 32).background(FridayColor.planSurface).clipShape(Circle())
                    }
                }

                VStack(spacing: 4) {
                    Text("Friday").font(.system(size: 12, weight: .medium)).foregroundColor(FridayColor.planMuted)
                    Text("Manage your subscription").font(.system(size: 24, weight: .bold)).foregroundColor(.white)
                }

                Toggle(isOn: $annual) {
                    HStack {
                        Text("Annual").foregroundColor(.white)
                        Text("Save 10%").font(.system(size: 11)).foregroundColor(FridayColor.planAccent)
                    }
                }
                .tint(FridayColor.planAccent)
                .padding(.horizontal, 8)

                if let statusMessage {
                    Text(statusMessage).font(.system(size: 13)).foregroundColor(statusIsError ? FridayColor.error : FridayColor.success)
                }

                ForEach(individualTiers, id: \.name) { tier in
                    tierCard(tier)
                }
            }
            .padding(20)
        }
        .background(FridayColor.planBg.ignoresSafeArea())
    }

    private func tierCard(_ tier: PlanTier) -> some View {
        let isCurrent = tier.name.lowercased() == vm.plan.lowercased()
        let price = annual ? Int(Double(tier.priceMonthly) * 0.9) : tier.priceMonthly
        return VStack(alignment: .leading, spacing: 14) {
            Text(tier.name).font(.system(size: 18, weight: .semibold)).foregroundColor(.white)
            Text(tier.priceMonthly == 0 ? "Free" : "₹\(price) /month").font(.system(size: 26, weight: .bold)).foregroundColor(.white)

            Button {
                guard !isCurrent else { return }
                Task { await purchase(tier) }
            } label: {
                Group {
                    if purchasing == tier.name {
                        ProgressView().tint(.white)
                    } else {
                        Text(isCurrent ? "Current Plan" : "Upgrade")
                    }
                }
                .font(.system(size: 15, weight: .semibold))
                .frame(maxWidth: .infinity).frame(height: 44)
                .foregroundColor(.white)
                .background(isCurrent ? FridayColor.planSurfaceRaised : FridayColor.planAccent)
                .cornerRadius(22)
            }
            .disabled(isCurrent || purchasing != nil)

            ForEach(tier.features, id: \.self) { feature in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "checkmark").font(.system(size: 12)).foregroundColor(FridayColor.planAccent)
                    Text(feature).font(.system(size: 13)).foregroundColor(.white.opacity(0.85))
                }
            }

            Rectangle().fill(FridayColor.planHairline).frame(height: 1)

            Text("MODELS UNLOCKED").font(.system(size: 11, weight: .medium)).foregroundColor(FridayColor.planMuted)
            FlowLayout(spacing: 6) {
                ForEach(tier.models, id: \.self) { model in
                    Text(model)
                        .font(.system(size: 11))
                        .foregroundColor(.white)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(FridayColor.planSurfaceRaised)
                        .cornerRadius(8)
                }
            }
        }
        .padding(18)
        .background(FridayColor.planSurface)
        .cornerRadius(20)
    }

    private func purchase(_ tier: PlanTier) async {
        purchasing = tier.name
        statusMessage = nil
        defer { purchasing = nil }
        do {
            let result = try await BillingApi.createOrder(planId: tier.name.lowercased(), billingCycle: annual ? "annual" : "monthly", seats: nil, organizationId: nil)
            guard let order = result["order"] as? [String: Any], let orderId = order["id"] as? String else {
                throw ApiError.decode
            }
            // Razorpay checkout SDK hand-off happens here in the full native
            // build; this port polls order status the same way the app does
            // once the SDK reports client-side success.
            let paid = await BillingApi.pollUntilPaid(orderId: orderId)
            statusIsError = !paid
            statusMessage = paid ? "Payment confirmed — your plan is updated." : "We couldn't confirm the payment yet."
            if paid { vm.plan = tier.name.lowercased() }
        } catch {
            statusIsError = true
            statusMessage = error.localizedDescription
        }
    }
}
