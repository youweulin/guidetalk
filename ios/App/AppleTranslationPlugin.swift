import Foundation
import Capacitor
import SwiftUI
import Translation

// MARK: - Translation Bridge (coordinates between Capacitor Plugin and SwiftUI)

@available(iOS 18.0, *)
class TranslationBridge: ObservableObject {
    @Published var configuration: TranslationSession.Configuration?

    private var pendingText: String = ""
    private var pendingCompletion: ((String?, String?) -> Void)?
    private var currentFrom: String = ""
    private var currentTo: String = ""

    /// Queue a translation request. Cancels any previous pending request.
    func request(text: String, from: String, to: String, completion: @escaping (String?, String?) -> Void) {
        // Cancel previous pending request so its Promise resolves
        pendingCompletion?(nil, "Cancelled by newer request")

        pendingText = text
        pendingCompletion = completion

        if from == currentFrom && to == currentTo {
            // Same language pair → invalidate to re-trigger .translationTask
            configuration?.invalidate()
        } else {
            // New language pair → create fresh configuration
            currentFrom = from
            currentTo = to
            configuration = .init(
                source: Locale.Language(identifier: from),
                target: Locale.Language(identifier: to)
            )
        }
    }

    /// Called from .translationTask when a session is ready
    func handleSession(_ session: TranslationSession) async {
        let text = pendingText
        let completion = pendingCompletion
        pendingText = ""
        pendingCompletion = nil

        guard !text.isEmpty, let done = completion else { return }

        do {
            let response = try await session.translate(text)
            await MainActor.run { done(response.targetText, nil) }
        } catch {
            await MainActor.run { done(nil, error.localizedDescription) }
        }
    }
}

// MARK: - Hidden SwiftUI View with .translationTask modifier

@available(iOS 18.0, *)
struct TranslationHelperView: View {
    @ObservedObject var bridge: TranslationBridge

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .translationTask(bridge.configuration) { session in
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

    // Type-erased to avoid @available issues at property level
    private var translationBridge: Any?
    private var hostingController: UIViewController?

    override public func load() {
        guard #available(iOS 18.0, *) else { return }

        let tBridge = TranslationBridge()
        self.translationBridge = tBridge

        DispatchQueue.main.async { [weak self] in
            let view = TranslationHelperView(bridge: tBridge)
            let hc = UIHostingController(rootView: view)
            hc.view.frame = .zero
            hc.view.isHidden = true
            self?.hostingController = hc

            if let parent = self?.bridge?.viewController {
                parent.addChild(hc)
                parent.view.addSubview(hc.view)
                hc.didMove(toParent: parent)
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
