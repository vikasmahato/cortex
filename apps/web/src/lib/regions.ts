import { REGIONS, type Region } from '@cortex/core';

export { REGIONS };
export type { Region };

export interface RegionMeta {
  label: string;
  /** plain-language kind of work this region stands for */
  activity: string;
  /** what the status indicator says while this region is the most active */
  status: string;
  role: string;
  color: string; // hex
}

export const REGION_META: Record<Region, RegionMeta> = {
  prefrontal: { status: 'Thinking', activity: 'Planning', label: 'Prefrontal', role: 'Planning & reasoning', color: '#a78bfa' },
  occipital: { status: 'Reading', activity: 'Reading', label: 'Occipital', role: 'Reading & perception', color: '#22d3ee' },
  motor: { status: 'Building', activity: 'Building', label: 'Motor', role: 'Building & acting', color: '#ff8a3d' },
  parietal: { status: 'Researching', activity: 'Researching', label: 'Parietal', role: 'Search & integration', color: '#4f8cff' },
  temporal: { status: 'Writing', activity: 'Writing & chat', label: 'Temporal', role: 'Language & dialogue', color: '#f472b6' },
  hippocampus: { status: 'Recalling', activity: 'Remembering', label: 'Hippocampus', role: 'Memory & recall', color: '#fde047' },
  cerebellum: { status: 'Testing', activity: 'Testing', label: 'Cerebellum', role: 'Testing & refinement', color: '#2dd4bf' },
  amygdala: { status: 'Hit a problem', activity: 'Problems', label: 'Amygdala', role: 'Errors & alarms', color: '#ff3b5c' },
};

export const regionIndex = (r: Region) => REGIONS.indexOf(r);
