import { describe, it, expect } from 'vitest';
import { encryptMnemonic, decryptMnemonic } from '../src/utils/keystore.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'motDePasseTest123!';

describe('Keystore — chiffrement AES-256-GCM', () => {
  describe('encryptMnemonic', () => {
    it('retourne un objet avec les champs requis', () => {
      const ks = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
      expect(ks).toHaveProperty('version', 1);
      expect(ks).toHaveProperty('salt');
      expect(ks).toHaveProperty('iv');
      expect(ks).toHaveProperty('tag');
      expect(ks).toHaveProperty('data');
    });

    it('salt, iv, tag et data sont en hexadécimal', () => {
      const ks = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
      const hexRegex = /^[0-9a-f]+$/i;
      expect(hexRegex.test(ks.salt)).toBe(true);
      expect(hexRegex.test(ks.iv)).toBe(true);
      expect(hexRegex.test(ks.tag)).toBe(true);
      expect(hexRegex.test(ks.data)).toBe(true);
    });

    it('le ciphertext ne contient pas le mnémonique en clair', () => {
      const ks = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
      const raw = JSON.stringify(ks);
      expect(raw).not.toContain(TEST_MNEMONIC);
      expect(raw).not.toContain('abandon');
    });

    it('deux chiffrements du même texte donnent des résultats différents (IV aléatoire)', () => {
      const ks1 = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
      const ks2 = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
      expect(ks1.iv).not.toBe(ks2.iv);
      expect(ks1.salt).not.toBe(ks2.salt);
      expect(ks1.data).not.toBe(ks2.data);
    });
  });

  describe('decryptMnemonic', () => {
    it('déchiffre correctement avec le bon mot de passe', () => {
      const ks       = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
      const result   = decryptMnemonic(ks, TEST_PASSWORD);
      expect(result).toBe(TEST_MNEMONIC);
    });

    it('lève une erreur avec un mauvais mot de passe', () => {
      const ks = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
      expect(() => decryptMnemonic(ks, 'mauvaisMotDePasse')).toThrow();
    });

    it('lève une erreur avec un mot de passe vide', () => {
      const ks = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
      expect(() => decryptMnemonic(ks, '')).toThrow();
    });

    it('lève une erreur si version inconnue', () => {
      const ks = { ...encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD), version: 99 };
      expect(() => decryptMnemonic(ks, TEST_PASSWORD)).toThrow(/Version keystore inconnue/);
    });

    it('lève une erreur si le data est corrompu', () => {
      const ks = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
      const corrupted = { ...ks, data: 'deadbeef'.repeat(10) };
      expect(() => decryptMnemonic(corrupted, TEST_PASSWORD)).toThrow();
    });
  });

  describe('cycle complet', () => {
    it('chiffrement → déchiffrement est idempotent', () => {
      const mnemonics = [
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
        'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
      ];

      for (const m of mnemonics) {
        const ks     = encryptMnemonic(m, TEST_PASSWORD);
        const result = decryptMnemonic(ks, TEST_PASSWORD);
        expect(result).toBe(m);
      }
    });
  });
});
