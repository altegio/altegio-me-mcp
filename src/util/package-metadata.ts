import { z } from 'zod';
import packageJson from '../../package.json' with { type: 'json' };

const PackageMetadataSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

const parsed = PackageMetadataSchema.safeParse(packageJson);
if (!parsed.success) {
  throw new Error('package.json must define name and version');
}

export const PACKAGE_NAME: string = parsed.data.name;
export const PACKAGE_VERSION: string = parsed.data.version;
