#!/usr/bin/env node

import { join } from "node:path";
import { OpenAPIProcessor } from "./processor.js";
import { ALGOD_CONFIG, KMD_CONFIG, INDEXER_CONFIG } from "./config.js";
import type { ProcessingConfig } from "./types.js";

// ===== SPEC DEFINITIONS =====

interface SpecDefinition {
  name: string;
  cliFlag: string;
  config: Omit<ProcessingConfig, "sourceUrl" | "outputPath">;
  github: {
    owner: string;
    repo: string;
    tagStrategy: "stable" | "latest-release";
    pathTemplate: (tag: string) => string;
  };
  outputFile: string;
}

const SPECS: SpecDefinition[] = [
  {
    name: "algod",
    cliFlag: "--algod-only",
    config: ALGOD_CONFIG,
    github: {
      owner: "algorand",
      repo: "go-algorand",
      tagStrategy: "stable",
      pathTemplate: (tag) => `https://raw.githubusercontent.com/algorand/go-algorand/${tag}/daemon/algod/api/algod.oas2.json`,
    },
    outputFile: "algod.oas3.json",
  },
  {
    name: "kmd",
    cliFlag: "--kmd-only",
    config: KMD_CONFIG,
    github: {
      owner: "algorand",
      repo: "go-algorand",
      tagStrategy: "stable",
      pathTemplate: (tag) => `https://raw.githubusercontent.com/algorand/go-algorand/${tag}/daemon/kmd/api/swagger.json`,
    },
    outputFile: "kmd.oas3.json",
  },
  {
    name: "indexer",
    cliFlag: "--indexer-only",
    config: INDEXER_CONFIG,
    github: {
      owner: "algorand",
      repo: "indexer",
      tagStrategy: "latest-release",
      pathTemplate: (tag) => `https://raw.githubusercontent.com/algorand/indexer/${tag}/api/indexer.oas2.json`,
    },
    outputFile: "indexer.oas3.json",
  },
];

// ===== TAG FETCHING =====

async function fetchLatestTag(owner: string, repo: string, strategy: "stable" | "latest-release"): Promise<string> {
  console.log(`ℹ️  Fetching latest ${strategy} tag for ${owner}/${repo}...`);

  try {
    if (strategy === "stable") {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/tags`);
      if (!response.ok) {
        throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
      }
      const tags = await response.json();
      const stableTag = tags.find((tag: any) => tag.name.includes("-stable"));
      if (!stableTag) {
        throw new Error("No stable tag found in the repository");
      }
      console.log(`✅ Found latest stable tag: ${stableTag.name}`);
      return stableTag.name;
    } else {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
      if (!response.ok) {
        throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
      }
      const release = await response.json();
      console.log(`✅ Found latest release tag: ${release.tag_name}`);
      return release.tag_name;
    }
  } catch (error) {
    console.error(`❌ Failed to fetch tag, falling back to master branch`);
    console.error(error instanceof Error ? error.message : error);
    return "master";
  }
}

// ===== SPEC PROCESSING =====

async function processSpec(spec: SpecDefinition): Promise<void> {
  const tag = await fetchLatestTag(spec.github.owner, spec.github.repo, spec.github.tagStrategy);
  const config: ProcessingConfig = {
    ...spec.config,
    sourceUrl: spec.github.pathTemplate(tag),
    outputPath: join(process.cwd(), "specs", spec.outputFile),
  };
  await new OpenAPIProcessor(config).process();
}

// ===== CLI =====

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check for single-spec flags
  const selectedSpec = SPECS.find((spec) => args.includes(spec.cliFlag));
  if (selectedSpec) {
    await processSpec(selectedSpec);
    return;
  }

  // Process all specs in parallel
  await Promise.all(SPECS.map(processSpec));
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
