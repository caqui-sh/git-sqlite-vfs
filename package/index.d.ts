export const GITVFS_EXTENSION_PATH: string;

export interface BootstrapOptions {
    dir?: string;
}

export function bootstrapGitVFS(options?: BootstrapOptions): Promise<void>;

export interface ConfigureGitOptions {
    repoDir: string;
    vfsDir: string;
}

export function configureGitIntegration(options: ConfigureGitOptions): Promise<void>;
