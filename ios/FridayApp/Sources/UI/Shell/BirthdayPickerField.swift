import SwiftUI

/// A calendar date picker for editing a YYYY-MM-DD birthday string — shared by the signup form
/// (Auth/AuthSheets.swift) and Settings' profile editor (Settings/SettingsScreen.swift), which
/// both used to be a bare text field asking the user to type a date by hand ("Birthday
/// (YYYY-MM-DD)") instead of picking one from a calendar.
struct BirthdayPickerField: View {
    @Binding var value: String
    var placeholder: String = "Birthday"

    @State private var showPicker = false
    @State private var pickerDate = Date()

    private static let isoFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    var body: some View {
        Button {
            pickerDate = Self.isoFormatter.date(from: value) ?? pickerDate
            showPicker = true
        } label: {
            HStack {
                Text(value.isEmpty ? placeholder : value)
                    .foregroundColor(value.isEmpty ? FridayColor.muted : FridayColor.text)
                Spacer()
            }
            .font(.system(size: 15))
            .padding(14)
            .background(FridayColor.surface)
            .cornerRadius(16)
        }
        .sheet(isPresented: $showPicker) {
            NavigationStack {
                DatePicker("Birthday", selection: $pickerDate, in: ...Date(), displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .padding()
                    .navigationTitle("Birthday")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") {
                                value = Self.isoFormatter.string(from: pickerDate)
                                showPicker = false
                            }
                        }
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showPicker = false }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
        }
    }
}
