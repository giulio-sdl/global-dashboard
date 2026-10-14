// Global Markets: the dashboard in a window of its own.
//
// A small Mac app around the dashboard's page. When it opens it makes sure the
// dashboard's server is running, starting it with scripts/open-dashboard.sh if
// not, and then shows the page. The server keeps running after the window is
// closed, as it does when the script is run by hand.
//
// scripts/build-mac-app.sh builds it and records in its Info.plist the project
// folder (DashboardFolder) and the port the server listens on (DashboardPort).

import Cocoa
import WebKit

let settings = Bundle.main.infoDictionary ?? [:]
let folder = settings["DashboardFolder"] as? String ?? ""
let port = settings["DashboardPort"] as? String ?? "5177"
let dashboard = URL(string: "http://localhost:\(port)/")!
// The "Try again" link of the page shown when the server could not be started.
let retryScheme = "global-markets-retry"

final class Controller: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var page: WKWebView!

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = mainMenu()
    page = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    page.navigationDelegate = self
    page.uiDelegate = self
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Global Markets"
    window.minSize = NSSize(width: 380, height: 480)
    window.contentView = page
    window.center()
    // The window opens where it was last left, at the size it was left.
    window.setFrameAutosaveName("GlobalMarkets")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    start()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  // Starts the server unless it already answers, then shows the dashboard.
  func start() {
    note("Starting the dashboard…")
    DispatchQueue.global().async {
      if !self.serverAnswers() { self.runStartScript() }
      let up = self.serverAnswers()
      DispatchQueue.main.async {
        if up {
          self.page.load(URLRequest(url: dashboard))
        } else {
          self.note("The dashboard's server did not start. Its log is in ~/Library/Logs/global-dashboard.log.", retry: true)
        }
      }
    }
  }

  // Asks the server for its configuration, as the page does first.
  func serverAnswers() -> Bool {
    var request = URLRequest(url: dashboard.appendingPathComponent("api/config"))
    request.timeoutInterval = 3
    let done = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: request) { _, response, _ in
      ok = (response as? HTTPURLResponse)?.statusCode == 200
      done.signal()
    }.resume()
    done.wait()
    return ok
  }

  // The script that opens the dashboard in a browser, told not to. It starts
  // the server detached, so it outlives this app, and waits for it to answer.
  func runStartScript() {
    let script = Process()
    script.executableURL = URL(fileURLWithPath: "/bin/zsh")
    script.arguments = [folder + "/scripts/open-dashboard.sh", "--no-open"]
    script.environment = ProcessInfo.processInfo.environment.merging(["PORT": port]) { _, set in set }
    try? script.run()
    script.waitUntilExit()
  }

  // A plain message in the window, in the dashboard's colours.
  func note(_ text: String, retry: Bool = false) {
    let link = retry ? "<p><a href=\"\(retryScheme):\">Try again</a></p>" : ""
    page.loadHTMLString("""
      <!doctype html><meta charset="utf-8">
      <style>
        body { margin: 0; height: 100vh; display: grid; place-items: center; font: 15px -apple-system, sans-serif;
               background: #0e0e10; color: #e8e8ea; text-align: center; }
        p { max-width: 32em; margin: 8px 24px; } a { color: #ffd60a; }
      </style>
      <p>\(text)</p>\(link)
      """, baseURL: nil)
  }

  // Links that lead away from the dashboard (the SEC's filings, say) open in
  // the default browser; the dashboard itself stays in this window.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.allow) }
    if url.scheme == retryScheme {
      decisionHandler(.cancel)
      start()
    } else if url.scheme == "about" || url.host == "localhost" {
      decisionHandler(.allow)
    } else {
      decisionHandler(.cancel)
      NSWorkspace.shared.open(url)
    }
  }

  // A link that asks for a new window (target="_blank") opens in the browser too.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  @objc func reload(_ sender: Any?) {
    if page.url?.host == "localhost" { page.reload() } else { start() }
  }

  @objc func openInBrowser(_ sender: Any?) {
    NSWorkspace.shared.open(dashboard)
  }

  func mainMenu() -> NSMenu {
    let menu = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) {
      let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      holder.submenu = NSMenu(title: title)
      items.forEach { holder.submenu!.addItem($0) }
      menu.addItem(holder)
    }
    func item(_ title: String, _ action: Selector?, _ key: String, _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let made = NSMenuItem(title: title, action: action, keyEquivalent: key)
      made.keyEquivalentModifierMask = modifiers
      return made
    }
    submenu("Global Markets", [
      item("About Global Markets", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      .separator(),
      item("Hide Global Markets", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      .separator(),
      item("Quit Global Markets", #selector(NSApplication.terminate(_:)), "q"),
    ])
    submenu("Edit", [
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    submenu("View", [
      item("Reload", #selector(reload(_:)), "r"),
      item("Open in Browser", #selector(openInBrowser(_:)), "o", [.command, .shift]),
      .separator(),
      item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    submenu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
    ])
    return menu
  }
}

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
