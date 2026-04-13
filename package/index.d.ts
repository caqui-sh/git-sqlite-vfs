export const GITVFS_EXTENSION_PATH: string;

export interface BootstrapOptions {
    dir?: string;
    libsql?: any;
}

export function bootstrapGitVFS(options?: BootstrapOptions): Promise<void>;

export interface CreateVFSClientOptions {
    clientOptions: any;
    createClient?: any;
}

export function createVFSClient(options: CreateVFSClientOptions | any): Promise<any>;

export interface ConfigureGitOptions {
    repoDir: string;
    vfsDir: string;
}

export function configureGitIntegration(options: ConfigureGitOptions): Promise<void>;
