const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

// Safely load token from process.env or .env file
let TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
    const envPaths = [
        path.join(__dirname, '../.env'),
        path.join(process.env.HOME || '', '.env')
    ];
    for (const p of envPaths) {
        if (fs.existsSync(p)) {
            const content = fs.readFileSync(p, 'utf8');
            const match = content.match(/^GITHUB_TOKEN=(.+)$/m);
            if (match) {
                TOKEN = match[1].trim().replace(/^['"]|['"]$/g, '');
                break;
            }
        }
    }
}

const REPO = (pkg.build && pkg.build.publish && pkg.build.publish.owner)
    ? `${pkg.build.publish.owner}/${pkg.build.publish.repo}`
    : 'chromaticpondering/Hatch';
const TAG = `v${pkg.version}`;
const RELEASE_NAME = `Hatch v${pkg.version}`;
const BODY = `### Release Notes: Hatch v${pkg.version}

**What's New in v${pkg.version}**
* **Landing Page Redesign:** Updated modern landing page for filmmakers and creative professionals.
* **Auto-Persistence & Sorting:** Added automatic persistence with alphabetical sorting for client names and project types.
* **Philomina Tribute Box:** Updated tribute box with app icon and refined typography.
* **UI & Alignment Polishing:** Fixed footer logo sizing, alignment, and directory structure theme improvements.
* **Cross-Platform Release:** Updated production binaries for macOS (Apple Silicon & Universal Intel), Windows (NSIS Installer), and Linux (AppImage & deb).

**Notes for Mac Installation**

Since Hatch is distributed independently, macOS Gatekeeper may prompt on first launch:

1. **The "Right-Click" Method (Recommended):**
   * Download the appropriate version for your Mac: **Apple Silicon** (M1/M2/M3/M4) or **Universal / Intel**.
   * Drag the **Hatch** icon to your **Applications** folder.
   * **Right-click** (or Control-click) the Hatch app in your Applications folder and select **Open**.
   * Click **Open** on the security warning dialog. *You will only need to do this once.*

2. **The Terminal Method (Bypass):**
   * If you see a message saying the app "is damaged" or cannot be verified, open Terminal and run:
   \`\`\`bash
   xattr -cr /Applications/Hatch.app
   \`\`\`
3. You can now open the app normally.`;

async function getOrCreateRelease() {
    console.log(`Checking for release ${TAG} in ${REPO}...`);

    // 1. Check if release exists
    const checkRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, {
        headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Hatch-Release-Script'
        }
    });

    if (checkRes.ok) {
        const release = await checkRes.json();
        console.log(`Release ${TAG} found: ${release.html_url}`);
        return release;
    }

    // 2. Create if not exists
    console.log(`Creating new release ${TAG}...`);
    const createRes = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Hatch-Release-Script'
        },
        body: JSON.stringify({
            tag_name: TAG,
            target_commitish: 'main',
            name: RELEASE_NAME,
            body: BODY,
            draft: false,
            prerelease: false
        })
    });

    if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(`Failed to create release: ${createRes.status} ${err}`);
    }

    const data = await createRes.json();
    console.log(`Release created: ${data.html_url}`);
    return data;
}

async function uploadAsset(release, filePath) {
    const fileName = path.basename(filePath);
    console.log(`Uploading ${fileName}...`);

    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        return;
    }

    // Check if asset already exists on the release and delete it first
    if (release.assets && Array.isArray(release.assets)) {
        const existing = release.assets.find(a => a.name === fileName);
        if (existing) {
            console.log(`Asset ${fileName} already exists (ID: ${existing.id}). Replacing...`);
            const delRes = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${existing.id}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'Hatch-Release-Script'
                }
            });
            if (!delRes.ok) {
                console.warn(`Warning: Could not delete old asset ${fileName}: ${delRes.status}`);
            }
        }
    }

    const stats = fs.statSync(filePath);
    const fileStream = fs.readFileSync(filePath);

    // Remove template params {?name,label}
    const cleanUrl = release.upload_url.replace(/{.*}/, '');
    const targetUrl = `${cleanUrl}?name=${encodeURIComponent(fileName)}`;

    const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/octet-stream',
            'Content-Length': stats.size,
            'User-Agent': 'Hatch-Release-Script'
        },
        body: fileStream
    });

    if (!response.ok) {
        const err = await response.text();
        console.error(`Failed to upload ${fileName}: ${response.status} ${err}`);
    } else {
        console.log(`✓ Uploaded ${fileName}`);
    }
}

async function main() {
    if (!TOKEN) {
        console.error('Error: GITHUB_TOKEN environment variable or .env file is required.');
        process.exit(1);
    }

    const releaseDir = path.join(__dirname, '../release');
    if (!fs.existsSync(releaseDir)) {
        console.error('Release directory not found.');
        process.exit(1);
    }

    const files = fs.readdirSync(releaseDir);

    // Define required patterns for platforms
    const requiredPlatforms = {
        'Mac (Apple Silicon)': `Hatch-${TAG.substring(1)}-arm64.dmg`,
        'Mac (Universal)': `Hatch-${TAG.substring(1)}-universal.dmg`,
        'Windows': `Hatch-Setup-${TAG.substring(1)}.exe`,
        'Linux': `Hatch-${TAG.substring(1)}-x86_64.AppImage`
    };

    console.log('Validating platform artifacts...');
    const missing = [];
    for (const [platform, fileName] of Object.entries(requiredPlatforms)) {
        if (!files.includes(fileName)) {
            missing.push(`${platform} (${fileName})`);
        } else {
            console.log(`✓ Found ${platform} artifact: ${fileName}`);
        }
    }

    if (missing.length > 0) {
        console.error('\n❌ ERROR: Missing required platform artifacts:');
        missing.forEach(m => console.error(`   - ${m}`));
        console.error('\nPlease ensure all builds are completed before running this script.');
        process.exit(1);
    }

    console.log('\nAll required platforms found. Proceeding with upload...');

    try {
        const release = await getOrCreateRelease();

        const assets = files.filter(f => {
            const ext = path.extname(f).toLowerCase();
            return ['.exe', '.dmg', '.zip', '.appimage', '.deb', '.yml'].includes(ext) && !f.endsWith('.blockmap');
        });

        console.log(`Found ${assets.length} artifacts to upload.`);

        for (const asset of assets) {
            await uploadAsset(release, path.join(releaseDir, asset));
        }
        console.log('All assets processed successfully.');
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

main();
