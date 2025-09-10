import fs from 'node:fs';
import path from 'node:path';

export class ArtifactsWriter {
  private framesPath: string;
  private promptPath: string;
  private resultPath: string;
  private metricsPath: string;

  constructor(baseDir = 'artifacts') {
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    this.framesPath = path.join(baseDir, 'frames.ndjson');
    this.promptPath = path.join(baseDir, 'prompt.json');
    this.resultPath = path.join(baseDir, 'result.json');
    this.metricsPath = path.join(baseDir, 'metrics.json');
  }

  appendFrame(event: string, data: unknown) {
    const line = JSON.stringify({ t: Date.now(), event, data }) + '\n';
    fs.appendFileSync(this.framesPath, line, 'utf8');
  }

  writePrompt(data: unknown) {
    fs.writeFileSync(this.promptPath, JSON.stringify(data, null, 2));
  }

  writeResult(data: unknown) {
    fs.writeFileSync(this.resultPath, JSON.stringify(data, null, 2));
  }

  writeMetrics(data: unknown) {
    fs.writeFileSync(this.metricsPath, JSON.stringify(data, null, 2));
  }
}
