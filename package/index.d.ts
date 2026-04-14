export const GITVFS_EXTENSION_PATH: string;

export interface CreateVFSClientOptions {
    clientOptions: any;
    createClient?: any;
    libsql?: any;
}

export function createVFSClient(options: CreateVFSClientOptions | any): Promise<any>;

export interface ConfigureGitOptions {
    repoDir: string;
    vfsDir: string;
}

export function configureGitIntegration(options: ConfigureGitOptions): Promise<void>;
