import { test } from 'jsr:@std/testing/bdd';
import { expect } from 'jsr:@std/expect';
import * as path from 'jsr:@std/path';

Deno.test('Production E2E Deno: Installs from NPM and downloads prebuilt binary', () => {
    const tempDir = Deno.makeTempDirSync({ prefix: 'git-sqlite-vfs-test-' });
    
    try {
        Deno.copyFileSync(path.join(Deno.cwd(), 'test', 'assets', 'deno.json'), path.join(tempDir, 'deno.json'));
        Deno.copyFileSync(path.join(Deno.cwd(), 'test', 'assets', 'test_script.ts'), path.join(tempDir, 'test_script.ts'));
        
        const runCmd = new Deno.Command('deno', { 
            args: ['run', '-A', '--reload', 'test_script.ts'], 
            cwd: tempDir,
            stdout: 'piped',
            stderr: 'piped'
        });
        const out = runCmd.outputSync();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr);
        
        if (!out.success) {
            console.log('STDOUT:', stdout);
            console.error('STDERR:', stderr);
        }
        
        expect(stdout).toContain('Successfully downloaded and extracted prebuilt binary');
        expect(stdout).not.toContain('Falling back to building from source');
        expect(stdout).toContain('Success Deno E2E');
        expect(out.success).toBe(true);

    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});
