import Foundation
import Capacitor
import StoreKit

@objc(InAppPurchasePlugin)
public class InAppPurchasePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "InAppPurchasePlugin"
    public let jsName = "InAppPurchase"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePurchases", returnType: CAPPluginReturnPromise),
    ]

    private var products: [String: Product] = [:]
    private var transactionListener: Task<Void, Error>?

    override public func load() {
        // 監聽交易更新（App 啟動時自動驗證未完成的交易）
        transactionListener = Task.detached { [weak self] in
            for await result in Transaction.updates {
                guard let self = self else { return }
                if case .verified(let transaction) = result {
                    await transaction.finish()
                    self.notifyPurchaseUpdate(transaction)
                }
            }
        }
    }

    deinit {
        transactionListener?.cancel()
    }

    // MARK: - getProducts

    @objc func getProducts(_ call: CAPPluginCall) {
        guard let productIds = call.getArray("productIds", String.self), !productIds.isEmpty else {
            call.reject("missing productIds")
            return
        }

        Task {
            do {
                let storeProducts = try await Product.products(for: Set(productIds))
                var result: [[String: Any]] = []

                for p in storeProducts {
                    products[p.id] = p
                    result.append([
                        "productId": p.id,
                        "displayName": p.displayName,
                        "description": p.description,
                        "price": p.price.description,
                        "displayPrice": p.displayPrice,
                    ])
                }

                call.resolve(["products": result])
            } catch {
                call.reject("Failed to load products: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - purchase

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId") else {
            call.reject("missing productId")
            return
        }

        Task {
            // 如果還沒載入過商品，先載入
            if products[productId] == nil {
                do {
                    let storeProducts = try await Product.products(for: [productId])
                    for p in storeProducts { products[p.id] = p }
                } catch {
                    call.reject("Product not found: \(error.localizedDescription)")
                    return
                }
            }

            guard let product = products[productId] else {
                call.reject("Product not found: \(productId)")
                return
            }

            do {
                let result = try await product.purchase()

                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let transaction):
                        await transaction.finish()
                        call.resolve([
                            "success": true,
                            "productId": transaction.productID,
                            "transactionId": String(transaction.id),
                        ])
                    case .unverified(_, let error):
                        call.reject("Unverified transaction: \(error.localizedDescription)")
                    }
                case .userCancelled:
                    call.reject("User cancelled")
                case .pending:
                    call.reject("Purchase pending approval")
                @unknown default:
                    call.reject("Unknown purchase result")
                }
            } catch {
                call.reject("Purchase failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - restorePurchases

    @objc func restorePurchases(_ call: CAPPluginCall) {
        Task {
            var restored: [[String: Any]] = []

            for await result in Transaction.currentEntitlements {
                if case .verified(let transaction) = result {
                    restored.append([
                        "productId": transaction.productID,
                        "transactionId": String(transaction.id),
                    ])
                }
            }

            call.resolve(["purchases": restored])
        }
    }

    // MARK: - Helpers

    private func notifyPurchaseUpdate(_ transaction: Transaction) {
        notifyListeners("purchaseUpdated", data: [
            "productId": transaction.productID,
            "transactionId": String(transaction.id),
        ])
    }
}
