import Foundation
import Capacitor
import SwiftUI
import Translation

// MARK: - Translation Bridge

@available(iOS 18.0, *)
class TranslationBridge: ObservableObject {
    @Published var configuration: TranslationSession.Configuration?

    private var pendingText: String = ""
    private var pendingCompletion: ((String?, String?) -> Void)?
    private var currentFrom: String = ""
    private var currentTo: String = ""

    func request(text: String, from: String, to: String, completion: @escaping (String?, String?) -> Void) {
        // Cancel previous pending request
        pendingCompletion?(nil, "Cancelled by newer request")

        pendingText = text
        pendingCompletion = completion

        print("[AppleTranslation] request: \(from) → \(to), text=\(text.prefix(30))")

        if from == currentFrom && to == currentTo {
            print("[AppleTranslation] same pair, invalidating config")
            configuration?.invalidate()
        } else {
            currentFrom = from
            currentTo = to
            print("[AppleTranslation] new pair, creating config")
            configuration = .init(
                source: Locale.Language(identifier: from),
                target: Locale.Language(identifier: to)
            )
        }
    }

    func handleSession(_ session: TranslationSession) async {
        print("[AppleTranslation] handleSession called!")
        let text = pendingText
        let completion = pendingCompletion
        pendingText = ""
        pendingCompletion = nil

        guard !text.isEmpty, let done = completion else {
            print("[AppleTranslation] no pending text or completion")
            return
        }

        do {
            let response = try await session.translate(text)
            print("[AppleTranslation] success: \(response.targetText.prefix(30))")
            await MainActor.run { done(response.targetText, nil) }
        } catch {
            print("[AppleTranslation] error: \(error)")
            await MainActor.run { done(nil, error.localizedDescription) }
        }
    }
}

// MARK: - SwiftUI View with .translationTask

@available(iOS 18.0, *)
struct TranslationHelperView: View {
    @ObservedObject var bridge: TranslationBridge

    var body: some View {
        // Must be non-hidden and non-zero for SwiftUI to evaluate modifiers
        Color.clear
            .frame(width: 1, height: 1)
            .translationTask(bridge.configuration) { session in
                print("[AppleTranslation] .translationTask fired!")
                await bridge.handleSession(session)
            }
    }
}

// MARK: - Capacitor Plugin

@objc(AppleTranslationPlugin)
public class AppleTranslationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleTranslationPlugin"
    public let jsName = "AppleTranslation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise)
    ]

    private var translationBridge: Any?
    private var hostingController: UIViewController?

    override public func load() {
        guard #available(iOS 18.0, *) else {
            print("[AppleTranslation] iOS < 18.0, skipping")
            return
        }

        print("[AppleTranslation] load() called, setting up SwiftUI bridge")

        let tBridge = TranslationBridge()
        self.translationBridge = tBridge

        DispatchQueue.main.async { [weak self] in
            let view = TranslationHelperView(bridge: tBridge)
            let hc = UIHostingController(rootView: view)

            // Off-screen but NOT hidden — SwiftUI must consider the view "alive"
            hc.view.frame = CGRect(x: -10, y: -10, width: 1, height: 1)
            hc.view.alpha = 0.01
            self?.hostingController = hc

            if let parent = self?.bridge?.viewController {
                parent.addChild(hc)
                parent.view.addSubview(hc.view)
                hc.didMove(toParent: parent)
                print("[AppleTranslation] SwiftUI hosting controller added to view hierarchy")
            } else {
                print("[AppleTranslation] ERROR: no parent viewController")
            }
        }
    }

    @objc func translate(_ call: CAPPluginCall) {
        guard #available(iOS 18.0, *) else {
            call.reject("Requires iOS 18.0+")
            return
        }

        guard let text = call.getString("text"),
              let from = call.getString("from"),
              let to = call.getString("to") else {
            call.reject("Missing text, from, or to parameters")
            return
        }

        guard let tBridge = translationBridge as? TranslationBridge else {
            call.reject("Translation not initialized")
            return
        }

        print("[AppleTranslation] translate() called from JS")

        DispatchQueue.main.async {
            tBridge.request(text: text, from: from, to: to) { translated, error in
                if let translated = translated {
                    call.resolve(["translated": translated])
                } else {
                    call.reject(error ?? "Translation failed")
                }
            }
        }
    }
}
