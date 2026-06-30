import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// 配置
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'cc-ding';
const MINIO_ALIAS = process.env.MINIO_ALIAS || 'myminio';
const MINIO_PATH = process.env.MINIO_PATH || 'releases'; // MinIO 中的路径

function run(command, args, options = {}) {
  const { silent = false } = options;
  if (!silent) {
    console.log(`> ${command} ${args.join(' ')}`);
  }
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: silent ? 'pipe' : 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (silent && result.stderr) {
      console.error(result.stderr.toString());
    }
    throw new Error(`Command failed with exit code ${result.status}`);
  }
  return result;
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}`);
  }
  return result.stdout?.toString() || '';
}

function getMinIOUrl() {
  try {
    const output = runCapture('mc', [ 'alias', 'list', MINIO_ALIAS ]);
    const urlMatch = output.match(/URL\s*:\s*(\S+)/);
    if (urlMatch) {
      return urlMatch[1].replace(/\/$/, ''); // 移除末尾斜杠
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function getPackageInfo() {
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return {
    name: pkg.name,
    version: pkg.version,
  };
}

function buildProject() {
  console.log('\n📦 Building project...');
  run('npm', [ 'run', 'build', '--silent' ], { silent: true });
  console.log('✅ Build complete');
}

function createTarball() {
  const { name, version } = getPackageInfo();
  const npmPackName = `${name}-${version}.tgz`;
  const tarballName = `${name}-latest.tgz`;

  // 确保 releases 目录存在
  const releasesDir = path.join(rootDir, 'releases');
  if (!fs.existsSync(releasesDir)) {
    fs.mkdirSync(releasesDir, { recursive: true });
  }

  // 使用 npm pack 创建压缩包（静默模式）
  run('npm', [ 'pack', '--silent' ], { cwd: rootDir, silent: true });

  // 移动并重命名 tgz 到 releases 目录
  const npmPackOutput = path.join(rootDir, npmPackName);
  const tarballPath = path.join(releasesDir, tarballName);

  if (fs.existsSync(npmPackOutput)) {
    fs.renameSync(npmPackOutput, tarballPath);
    console.log(`📋 Tarball created: ${name}-latest.tgz`);
    return tarballPath;
  }

  throw new Error('Failed to create tarball');
}

function uploadToMinIO(tarballPath) {
  const { name } = getPackageInfo();

  // 确保 bucket 存在（静默）
  try {
    run('mc', [ 'mb', `${MINIO_ALIAS}/${MINIO_BUCKET}`, '--ignore-existing' ], { silent: true });
  } catch (e) {
    // Bucket might already exist, ignore error
  }

  // 只上传 latest 包（静默）
  const latestDest = `${MINIO_ALIAS}/${MINIO_BUCKET}/${MINIO_PATH}/${name}-latest.tgz`;
  run('mc', [ 'cp', tarballPath, latestDest, '--quiet' ], { silent: true });

  console.log(`🚀 Uploaded to MinIO`);

  return {
    latest: `${MINIO_BUCKET}/${MINIO_PATH}/${name}-latest.tgz`,
  };
}

function printInstallInstructions(paths) {
  const minioUrl = getMinIOUrl();

  console.log('\n📝 Install command:');
  if (minioUrl) {
    console.log(`npm install ${minioUrl}/${paths.latest}`);
  } else {
    console.log(`npm install https://<minio-host>/${paths.latest}`);
  }
}

async function main() {
  const { name, version } = getPackageInfo();
  console.log(`🚀 Publishing ${name}@${version}`);

  try {
    // 1. 构建项目
    buildProject();

    // 2. 创建压缩包
    const tarballPath = createTarball();

    // 3. 上传到 MinIO
    const paths = uploadToMinIO(tarballPath);

    // 4. 打印安装说明
    printInstallInstructions(paths);

    console.log('\n🎉 Publish complete!');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  }
}

main();
