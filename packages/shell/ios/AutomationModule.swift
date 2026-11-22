import ExpoModulesCore
import Foundation

public class AutomationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaAutomation")

    Events("onRequest", "onClose", "onWritten")

    OnCreate {
      ControlSocket.shared.attach(self) { [weak self] name, body in self?.sendEvent(name, body) }
    }

    AsyncFunction("start") { (promise: Promise) in
      ControlSocket.shared.start { promise.resolve($0) }
    }

    AsyncFunction("stop") { (promise: Promise) in
      ControlSocket.shared.stop { promise.resolve(nil) }
    }

    Function("reply") { (connection: Int, line: String, ticket: Int) in
      ControlSocket.shared.reply(connection, line, ticket: ticket)
    }

    AsyncFunction("peer") { (connection: Int, promise: Promise) in
      ControlSocket.shared.peer(connection) { promise.resolve($0) }
    }

    Function("broadcast") { (connections: [Int], line: String) in
      ControlSocket.shared.broadcast(connections, line)
    }

    OnDestroy {
      ControlSocket.shared.detach(self)
    }
  }
}
