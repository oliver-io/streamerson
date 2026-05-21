import fs from 'fs';
import path from 'path';
import {exec, execSync} from 'child_process';
// Plain markers (the `colors` package's named exports don't resolve under Bun).
const green = (s: string) => s;
const yellow = (s: string) => s;
import minimist from 'minimist';
const commandLineArgs = minimist(process.argv.slice(2));
const directoryDenyList = [".yalc", "dist/**/*", "tmp/**/*", "node_modules", "deps", '**/node_modules/**/*', "**/LICENSE.md"]

const supportedFileExtensions = [
    ".ts",
    ".js",
    ".md",
];

// Meta-docs are authored by hand and not part of the generated doc system.
const metaDocs = new Set(['CLAUDE.md', 'PROJECT.md', 'MODERNIZE.md']);
const denied = (f: string) =>
  f.includes('node_modules') || f.startsWith('dist/') || f.includes('/dist/') ||
  f.includes('.yalc') || f.includes('/deps/') || f.includes('benchmarking/deploy') ||
  f.endsWith('LICENSE.md') || metaDocs.has(f);

// Bun-native file discovery (the `glob` v7 dep doesn't return arrays under Bun).
async function globFiles(...patterns: string[]): Promise<string[]> {
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for await (const file of new Bun.Glob(pattern).scan({ onlyFiles: true })) {
      const rel = file.replaceAll('\\', '/');
      if (!denied(rel)) seen.add(rel);
    }
  }
  return [...seen];
}

async function getAllCodeFiles(dir?: string) {
    return await globFiles(dir ?? 'packages/**/*.ts');
}

type AddContentArgs = {
    relativeFilePath: string,
    absoluteFilePath: string
};

export function tagWithType(content: string, file: string) {
    const type = path.extname(file).replace('.', '');
    if (!supportedFileExtensions.includes(`.${type}`)) {
        throw new Error(`Unsupported file type ${type}`)
    }
    switch(type) {
        case 'ts':
            return '```typescript\n' + content + '\n```';
        default:
            return `\n${content}\n`;
    }
}

export async function addEmbeddings(options: AddContentArgs) {
  let embedded = 0;

  try {
    const readme = (await fs.promises.readFile(options.absoluteFilePath)).toString();
    const dir = path.resolve(`${options.absoluteFilePath}/..`);

    // Each block is matched as a whole: the END marker is always rewritten to
    // the BEGIN marker's path, so mismatched/stale pairs can't drift (the old
    // implementation paired BEGIN/END by index without checking the path).
    const blockRegex = /<!-- BEGIN-CODE:\s*(.*?)\s*-->[\s\S]*?<!-- END-CODE:.*?-->/g;

    const updated = readme.replace(blockRegex, (_match, ref: string) => {
      const fileReference = ref.trim();
      const filePath = path.resolve(dir, fileReference);
      const begin = `<!-- BEGIN-CODE: ${fileReference} -->`;
      const end = `<!-- END-CODE: ${fileReference} -->`;
      try {
        const content = fs.readFileSync(filePath).toString();
        const base = fileReference.substring(fileReference.lastIndexOf('/') + 1);
        const href = `[**${base}**](${fileReference})`;
        embedded++;
        return `${begin}\n${href}\n${tagWithType(content, filePath)}\n${end}`;
      } catch {
        console.error(`${yellow('X')} Missing embed source in ${options.relativeFilePath}: ${fileReference}`);
        // Normalize the markers but leave the body empty rather than dropping the block.
        return `${begin}\n${end}`;
      }
    });

    fs.writeFileSync(options.absoluteFilePath, updated);
  } catch(err) {
    console.error(err, `Failed embedding for file: ${options.relativeFilePath}`);
  }

  return {
    path,
    embedded
  }
}

export async function addTableOfContents(options: AddContentArgs) {
    // Only manage a TOC where the author opted in with doctoc markers — don't
    // force one onto docs that don't have it.
    if (!fs.readFileSync(options.absoluteFilePath, 'utf8').includes('<!-- START doctoc')) {
        return false;
    }
    return new Promise((resolve)=>{
        let buf = '';
        const child = exec(`doctoc ${options.absoluteFilePath} --github`);
        if (child.stdout) {
            child.stdout.on('data', (d)=>{
                buf += d;
            });
        }
        child.on('exit', (code)=>{
            const output = buf.toString().trim();
            resolve(
                output.includes('Everything is OK') &&
                output.includes('will be updated')
            );
        });
    });
}

export async function generateCodeDocs(options: AddContentArgs):Promise<string> {
    return new Promise<string>((resolve)=>{
        let buf = '';
        const destPath = options.relativeFilePath.replace(/\\/g, '/') + '/../_API.md';
        const inputPath = options.relativeFilePath.replace(/\\/g, '/');
        const command = `tsdoc --src=${inputPath} --dest=${destPath}`;
        const child = exec(command);
        if (child.stdout) {
            child.stdout.on('data', (d)=>{
                buf += d;
            });
        }
        child.on('exit', (code)=>{
            resolve(buf.toString());
        });
    });
}

export async function findAllMarkdown() {
    return await globFiles('*.md', 'docs/**/*.md', 'packages/**/*.md');
}

async function enrichFile(target: string) {
    const pathArgs = {
        relativeFilePath: path.relative(process.cwd(), target),
        absoluteFilePath: path.resolve(target)
    };
    const [addEmbeds, addTOC] = await Promise.all([
        addEmbeddings(pathArgs),
        addTableOfContents(pathArgs)
    ]);


    if ((commandLineArgs.verbose || commandLineArgs.v) || !commandLineArgs.summary) {
        if ((addEmbeds.embedded || addTOC) || (commandLineArgs.verbose || commandLineArgs.v)) {
            console.group(pathArgs.absoluteFilePath);
            console.log(`${addEmbeds.embedded ? green('✓') : yellow('X')} ${
                addEmbeds.embedded ? 'Added ' + addEmbeds.embedded + ' Embeddings' : 'No Embeddings Added'
            };`);
            console.log(`${addTOC ? green('✓') : yellow('X')} DocToc Generated);`);
            console.groupEnd();
        }
    }

    return {
        embeddings: addEmbeds.embedded,
        doctoc: addTOC ? 1 : 0
    }
}

async function enrichArtilleryReports() {
  const files = await globFiles('packages/**/_reports/loadtest/*.json', 'packages/**/_reports/gcp/*.json');
  let generated = 0;
  for (const file of files) {
    execSync(`artillery report ${file} --output ${file.replace('.json', '.html')}`);
    generated++;
  }
  return generated;
}

async function cli() {
    const artilleryHTMLGenerated = await enrichArtilleryReports();
    const codeFiles = await getAllCodeFiles();
    const annotatedFiles = (await Promise.all(codeFiles.map(async (codePath)=>{
        try {
            const codeText = (await fs.promises.readFile(codePath)).toString();
            if(codeText.includes('@param')) {
                return codePath;
            } else {
                return false;
            }
        } catch(err) {
            return false;
        }
    }))).filter(f=>!!f)

    await Promise.all(annotatedFiles.map(async eligibleFile=>{
        await generateCodeDocs({
            absoluteFilePath: eligibleFile! as string,
            relativeFilePath: path.relative(process.cwd(), eligibleFile! as string)
        });
    }));

    const files = await findAllMarkdown();
    const result = await Promise.all(files.map(enrichFile));
    if (commandLineArgs.summary) {
        let doctoc = 0;
        let embed = 0;
        for (const item of result) {
            doctoc+=item.doctoc;
            embed+=item.embeddings;
        }

        console.log(((doctoc + embed) ? green('✓ ') : yellow('x ')) + `Updated ${
            doctoc ? green(doctoc.toString()) : yellow('0')
        } DocTocs, ${
          artilleryHTMLGenerated ? green(artilleryHTMLGenerated.toString()) : yellow('0')
        } Artillery Reports, ${
            embed ? green(embed.toString()) : yellow('0')
        } Embeddings, and ${
          annotatedFiles.length ? green(annotatedFiles.length.toString()) : yellow('0')
        } TSDocs`);
    }
}

if (commandLineArgs.write || commandLineArgs.w) {
    cli().catch(console.error);
}
