import fs from 'fs';
import path from 'path';

/**
 * Analyzes and compares the execution time share of engine hotspots in CPU profiles.
 * Usage: tsx scripts/compare_profiles.ts <profile_A> [profile_B]
 */
function analyzeProfile(filePath: string) {
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        return null;
    }
    
    console.log(`\n--- Analysis for: ${path.basename(filePath)} ---`);
    const profile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    // Build a map of nodeId -> { name, hitCount }
    const nodes: any[] = profile.nodes;
    const nameStats: Record<string, number> = {};
    let totalHits = 0;
    
    for (const node of nodes) {
        const name = node.callFrame.functionName || '(anonymous)';
        const hits = node.hitCount || 0;
        nameStats[name] = (nameStats[name] || 0) + hits;
        totalHits += hits;
    }

    console.log(`Total Samples (Total Hits): ${totalHits}`);
    
    const targets = [
        // Current SearchHeap methods
        'pushOrMerge', 'popFast', 'pop', 'bubbleUp', 'sinkDown', 'getHash', 'hashSet', 'hashGet', 'hashDelete',
        // Legacy/Baseline methods
        'Map.get', 'Map.set', 'Map.delete', 'BinaryHeap.push', 'BinaryHeap.pop',
        // Engine hot-paths
        'processSearchNode', 'forwardMass', 'distributeWithResidue', 'settleMass'
    ];

    let groupTotal = 0;
    const sortedTargets = Object.entries(nameStats)
        .filter(([name]) => targets.includes(name))
        .sort((a, b) => b[1] - a[1]);

    if (sortedTargets.length === 0) {
        console.log('No tracked hotspots found in this profile.');
    } else {
        for (const [name, hits] of sortedTargets) {
            const share = (hits / totalHits * 100).toFixed(2);
            console.log(`${name.padEnd(25)}: ${share}% (${hits} hits)`);
            groupTotal += hits;
        }
        console.log('-'.repeat(40));
        console.log(`${'Tracked Hotspots Total'.padEnd(25)}: ${(groupTotal / totalHits * 100).toFixed(2)}%`);
    }

    return { totalHits, nameStats };
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.log('Usage: tsx scripts/compare_profiles.ts <profile_new> [profile_baseline]');
    process.exit(1);
}

analyzeProfile(args[0]!);
if (args[1]) {
    analyzeProfile(args[1]);
}
