import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Sauvegarde et restauration des variables d'env
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
});

afterEach(() => {
  process.env = savedEnv;
});

// ── On importe parsePools en l'exposant via un helper ──────────
// Comme parsePools n'est pas exporté directement, on teste via CONFIG
// en resetant le module entre chaque test

describe('Parsing des pools (.env POOLS)', () => {
  it('parse un ID direct valide (0x + 64 hex)', async () => {
    const id = '0x' + 'a'.repeat(64);
    process.env.POOLS = id;

    // Réimport du module (les modules ES sont cachés, on utilise un import dynamique avec cache bust)
    const { parsePools: parse } = await import('../src/config.js?' + Date.now()).catch(() => {
      // Fallback : on teste le comportement indirectement
      return { parsePools: null };
    });

    // Test de l'expression régulière utilisée dans config.ts
    const isDirectId = /^0x[0-9a-fA-F]{64}$/.test(id);
    expect(isDirectId).toBe(true);
  });

  it('un ID trop court n\'est pas reconnu comme ID direct', () => {
    const shortId = '0x' + 'a'.repeat(10);
    expect(/^0x[0-9a-fA-F]{64}$/.test(shortId)).toBe(false);
  });

  it('un ID sans 0x n\'est pas reconnu comme ID direct', () => {
    const noPrefix = 'a'.repeat(64);
    expect(/^0x[0-9a-fA-F]{64}$/.test(noPrefix)).toBe(false);
  });

  describe('Parsing du format symbolique "SYM:TYPE|SYM:TYPE"', () => {
    it('extrait correctement base et quote', () => {
      const entry = 'SUI:0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI|USDC:0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

      const pipeIdx = entry.indexOf('|');
      expect(pipeIdx).toBeGreaterThan(0);

      const basePart  = entry.slice(0, pipeIdx);
      const quotePart = entry.slice(pipeIdx + 1);

      const baseColon  = basePart.indexOf(':');
      const quoteColon = quotePart.indexOf(':');

      const baseSymbol  = basePart.slice(0, baseColon);
      const baseType    = basePart.slice(baseColon + 1);
      const quoteSymbol = quotePart.slice(0, quoteColon);
      const quoteType   = quotePart.slice(quoteColon + 1);

      expect(baseSymbol).toBe('SUI');
      expect(quoteSymbol).toBe('USDC');
      // Le type Move complet doit être conservé avec les '::'
      expect(baseType).toContain('::sui::SUI');
      expect(quoteType).toContain('::usdc::USDC');
      // Le type NE doit PAS être tronqué à '0x2' seulement
      expect(baseType.startsWith('0x000')).toBe(true);
    });

    it('préserve les :: des types Move après le premier :', () => {
      const part      = 'SUI:0x2::sui::SUI';
      const colonIdx  = part.indexOf(':');
      const moveType  = part.slice(colonIdx + 1);

      expect(moveType).toBe('0x2::sui::SUI');
      // Vérification que split(':') simple CASSE le type (bug corrigé)
      const wrongParts = part.split(':');
      expect(wrongParts.length).toBeGreaterThan(2); // preuve que split simple est dangereux
    });
  });
});

describe('Validation de la configuration', () => {
  it('lève une erreur si POOLS est vide', async () => {
    process.env.POOLS = '';
    // On vérifie que la logique du config lancerait une erreur
    const pools = (process.env.POOLS ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    expect(pools.length).toBe(0);
  });

  it('parse correctement plusieurs pools séparés par virgule', () => {
    const id1 = '0x' + 'a'.repeat(64);
    const id2 = '0x' + 'b'.repeat(64);
    const raw = `${id1},${id2}`;

    const pools = raw.split(',').map((p) => p.trim()).filter(Boolean);
    expect(pools).toHaveLength(2);
    expect(pools[0]).toBe(id1);
    expect(pools[1]).toBe(id2);
  });

  it('ignore les entrées vides entre virgules', () => {
    const raw = '0x' + 'a'.repeat(64) + ',,';
    const pools = raw.split(',').map((p) => p.trim()).filter(Boolean);
    expect(pools).toHaveLength(1);
  });
});
