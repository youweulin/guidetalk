import Foundation
import Capacitor
import Translation

@available(iOS 17.4, *)
@objc(AppleTranslationPlugin)
public class AppleTranslationPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "AppleTranslationPlugin"
    public let jsName = "AppleTranslation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise)
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 17.4, *) {
            call.resolve(["available": true])
        } else {
            call.resolve(["available": false])
        }
    }

    @objc func translate(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else {
            call.reject("Missing text")
            return
        }
        let fromLang = call.getString("from") ?? "zh"
        let toLang = call.getString("to") ?? "ja"

        if fromLang == toLang {
            call.resolve(["translated": text])
            return
        }

        Task {
            do {
                let source = Locale.Language(identifier: fromLang)
                let target = Locale.Language(identifier: toLang)
                let config = TranslationSession.Configuration(source: source, target: target)
                let session = TranslationSession(configuration: config)
                let response = try await session.translate(text)
                call.resolve(["translated": response.targetText])
            } catch {
                call.reject("Translation failed: \(error.localizedDescription)")
            }
        }
    }
}
