import Foundation
import Capacitor
import AuthenticationServices

@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {

    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]

    private var call: CAPPluginCall?

    @objc func authorize(_ call: CAPPluginCall) {
        self.call = call

        let provider = ASAuthorizationAppleIDProvider()
        let request = provider.createRequest()
        request.requestedScopes = [.email, .fullName]

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self

        DispatchQueue.main.async {
            controller.performRequests()
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return self.bridge?.webView?.window ?? UIWindow()
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            call?.reject("No credential")
            return
        }

        var result: [String: Any] = [:]

        if let identityToken = credential.identityToken,
           let tokenString = String(data: identityToken, encoding: .utf8) {
            result["identityToken"] = tokenString
        }

        if let authCode = credential.authorizationCode,
           let codeString = String(data: authCode, encoding: .utf8) {
            result["authorizationCode"] = codeString
        }

        result["user"] = credential.user
        result["email"] = credential.email ?? ""

        if let fullName = credential.fullName {
            result["givenName"] = fullName.givenName ?? ""
            result["familyName"] = fullName.familyName ?? ""
        }

        call?.resolve(result)
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        call?.reject(error.localizedDescription)
    }
}
