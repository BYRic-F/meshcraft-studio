import { describe, it, expect } from 'vitest';
import { searchNcbiMesh } from '../../src/services/meshDatabase';

describe('Check Comparator Resolution', () => {
  it('doit court-circuiter (Hard Drop) un comparateur passif tel que Alimentation habituelle', async () => {
    const res = await searchNcbiMesh('Alimentation habituelle ou absence de restriction');
    expect(res).toBeNull();
  }, 45000);
});
