// File: scripts/static-stress.tsx  v1.0
// Discovery doc §9.5 verification: does <Static> re-render when an
// adjacent live component updates at ~30ms cadence (matching the
// observed SSE delta cadence from the Phase A gate test)?
//
// Method:
// - Render 5 <Static> items, each with a render counter via useRef
// - Render an <ActiveTurn> that increments a counter every 30ms for ~3s (~100 ticks)
// - Each Static item logs to stderr on every render
// - At end, log static render counts and a verdict
//
// PASS criterion: each Static item renders once (or at most twice for the
// initial mount). FAIL: Static items render >5 times during the live updates.
//
// Run: bun run scripts/static-stress.tsx

import React, { useState, useEffect, useRef } from "react";
import { render, Text, Box, Static, useApp } from "ink";
import { writeFileSync, appendFileSync } from "fs";
import { join } from "path";

const EVIDENCE_PATH = join(import.meta.dir, "static-stress-evidence.txt");
writeFileSync(EVIDENCE_PATH, "");
const writeLog = (s: string) => appendFileSync(EVIDENCE_PATH, s);

type HistItem = { id: number; text: string };
const HIST: HistItem[] = [
  { id: 1, text: "[user] message 1" },
  { id: 2, text: "[asst] reply 1" },
  { id: 3, text: "[user] message 2" },
  { id: 4, text: "[asst] reply 2" },
  { id: 5, text: "[user] message 3" },
];

const renderLog: { id: number; renderCount: number }[] = [];
let activeRenderCount = 0;

function StaticItem({ item }: { item: HistItem }) {
  const counter = useRef(0);
  counter.current += 1;
  writeLog(`[STATIC-RENDER] id=${item.id} count=${counter.current}\n`);
  // record into outer log (mutate in place — fine for verification only)
  const existing = renderLog.find((r) => r.id === item.id);
  if (existing) existing.renderCount = counter.current;
  else renderLog.push({ id: item.id, renderCount: counter.current });
  return <Text dimColor>{item.text}</Text>;
}

function ActiveTurn({ tick }: { tick: number }) {
  activeRenderCount += 1;
  return (
    <Box flexDirection="column">
      <Text color="yellow">▶ active (tick={tick}, render#{activeRenderCount})</Text>
      <Text>
        {Array.from({ length: Math.min(tick, 50) })
          .map(() => "·")
          .join("")}
      </Text>
    </Box>
  );
}

function StressApp() {
  const { exit } = useApp();
  const [tick, setTick] = useState(0);
  const [done, setDone] = useState(false);
  const TARGET_TICKS = 100;

  useEffect(() => {
    if (done) return;
    const id = setInterval(() => {
      setTick((t) => {
        const next = t + 1;
        if (next >= TARGET_TICKS) {
          clearInterval(id);
          setDone(true);
        }
        return next;
      });
    }, 30);
    return () => clearInterval(id);
  }, [done]);

  useEffect(() => {
    if (!done) return;
    // Give one more render frame, then exit.
    const id = setTimeout(() => {
      writeLog(`\n=== Stress test summary ===\n`);
      writeLog(`ActiveTurn renders: ${activeRenderCount}\n`);
      const sortedHist = [...renderLog].sort((a, b) => a.id - b.id);
      for (const r of sortedHist) {
        writeLog(`Static id=${r.id} renders: ${r.renderCount}\n`);
      }
      const maxStatic = Math.max(...renderLog.map((r) => r.renderCount));
      const verdict = maxStatic <= 2 ? "PASS" : "FAIL";
      writeLog(`max Static renders: ${maxStatic}\n`);
      writeLog(`VERDICT: ${verdict}\n`);
      exit();
    }, 50);
    return () => clearTimeout(id);
  }, [done, exit]);

  return (
    <Box flexDirection="column">
      <Static items={HIST}>
        {(item) => <StaticItem key={item.id} item={item} />}
      </Static>
      <Box marginTop={1}>
        <ActiveTurn tick={tick} />
      </Box>
    </Box>
  );
}

const { waitUntilExit } = render(<StressApp />);
await waitUntilExit();
process.exit(0);
