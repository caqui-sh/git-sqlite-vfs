import * as path from "@std/path";
import { registerSharedTests } from "./shared_suite.ts";

async function runGit(cwd: string, ...args: string[]) {
  const cmd = new Deno.Command("git", { args, cwd });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`Git command failed: git ${args.join(" ")}\n${new TextDecoder().decode(stderr)}`);
  }
}

async function setupGitProject(tempDir: string, driverPath: string) {
  try {
    await runGit(tempDir, "init", "-b", "main");
  } catch {
    await runGit(tempDir, "init");
    await runGit(tempDir, "checkout", "-b", "main");
  }
  await runGit(tempDir, "config", "user.email", "test@example.com");
  await runGit(tempDir, "config", "user.name", "Test User");

  const driverDir = path.dirname(driverPath);
  Deno.env.set("PATH", `${driverDir}:${Deno.env.get("PATH")}`);

  await Deno.writeTextFile(path.resolve(tempDir, "README.md"), "# Test Project\n");
  await runGit(tempDir, "add", "README.md");
  await runGit(tempDir, "commit", "-m", "Initial_commit");
}

registerSharedTests(runGit, setupGitProject);