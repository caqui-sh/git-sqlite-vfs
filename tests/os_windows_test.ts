import * as path from "@std/path";
import { registerSharedTests } from "./shared_suite.ts";

async function runGit(cwd: string, ...args: string[]) {
  const processedArgs = args.map(arg => (arg.includes(" ") && !arg.startsWith("\"")) ? `"${arg}"` : arg);
  const cmd = new Deno.Command("git", { 
    args: processedArgs, 
    cwd,
    env: Deno.env.toObject()
  });
  const { code, stderr } = await cmd.output();  if (code !== 0) {
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
  const oldPath = Deno.env.get("PATH") || Deno.env.get("Path") || "";
  const newPath = `${driverDir};${oldPath}`;
  
  Deno.env.set("PATH", newPath);
  Deno.env.set("Path", newPath);

  const exeName = "git-merge-sqlitevfs.exe";
  
  const bashWrapper = path.resolve(driverDir, "git-merge-sqlitevfs");
  Deno.writeTextFileSync(bashWrapper, `#!/bin/sh\nexec "$(dirname "$0")/${exeName}" "$@"\n`);
  
  const cmdWrapper = path.resolve(driverDir, "git-merge-sqlitevfs.cmd");
  Deno.writeTextFileSync(cmdWrapper, `@echo off\n"%~dp0${exeName}" %*\n`);

  await Deno.writeTextFile(path.resolve(tempDir, "README.md"), "# Test Project\n");
  await runGit(tempDir, "add", "README.md");
  await runGit(tempDir, "commit", "-m", "Initial_commit");
}

registerSharedTests(runGit, setupGitProject);