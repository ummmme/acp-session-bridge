import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Test only: keep the process serving ACP independent of its launcher's lifetime.
// Forward the real transport and lease; the launcher never handles ACP requests.
const agent = spawn(
  process.execPath,
  [fileURLToPath(new URL("./fake_scoped_session_agent.ts", import.meta.url))],
  {
    detached: true,
    windowsHide: true,
    stdio: ["inherit", "inherit", "inherit", 3],
  },
);
agent.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
