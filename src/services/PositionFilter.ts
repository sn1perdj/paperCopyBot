
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const POSITIONS_LOG_FILE = path.join(DATA_DIR, 'positions_log.json');

export class PositionFilter {
    private blacklistedMarketIds: Set<string>;

    constructor() {
        this.blacklistedMarketIds = new Set();
        this.load();
    }

    private load() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        if (fs.existsSync(POSITIONS_LOG_FILE)) {
            try {
                const data = fs.readFileSync(POSITIONS_LOG_FILE, 'utf-8');
                const json = JSON.parse(data);
                if (Array.isArray(json)) {
                    this.blacklistedMarketIds = new Set(json);
                    console.log(`[FILTER] Loaded ${this.blacklistedMarketIds.size} blacklisted positions from file.`);
                }
            } catch (e) {
                console.error('[FILTER] Failed to load positions log:', e);
            }
        }
    }

    public save() {
        try {
            const data = JSON.stringify(Array.from(this.blacklistedMarketIds), null, 2);
            fs.writeFileSync(POSITIONS_LOG_FILE, data);
            // console.log('[FILTER] Saved blacklist to file.');
        } catch (e) {
            console.error('[FILTER] Failed to save positions log:', e);
        }
    }

    public initialize(existingMarketIds: string[]) {
        let newadditions = 0;
        for (const id of existingMarketIds) {
            if (!this.blacklistedMarketIds.has(id)) {
                this.blacklistedMarketIds.add(id);
                newadditions++;
            }
        }
        if (newadditions > 0) {
            console.log(`[FILTER] Added ${newadditions} new positions to blacklist from initial scan.`);
            this.save();
        }
    }

    public isBlacklisted(marketId: string): boolean {
        return this.blacklistedMarketIds.has(marketId);
    }

    public addToBlacklist(marketId: string) {
        if (!this.blacklistedMarketIds.has(marketId)) {
            this.blacklistedMarketIds.add(marketId);
            this.save();
        }
    }
}

export default PositionFilter;
