import { describe, it, expect } from "vitest";
import {
  isSecretExpression,
  extractSecretExpressions,
  containsSecrets,
  maskSecretValue,
  maskInterpolatedString,
  encryptForStorage,
  decryptFromStorage,
  isEncryptedData,
  encryptSecretInputs,
  decryptSecretInputs,
  SECRET_MASK,
} from "./secrets.js";

describe("secrets", () => {
  describe("isSecretExpression", () => {
    it("should treat all env.* expressions as secrets", () => {
      expect(isSecretExpression("env.API_KEY", [])).toBe(true);
      expect(isSecretExpression("env.DATABASE_PASSWORD", [])).toBe(true);
      expect(isSecretExpression("env.HOME", [])).toBe(true);
    });

    it("should treat inputs in secrets array as secrets", () => {
      const secrets = ["password", "apiKey"];
      expect(isSecretExpression("inputs.password", secrets)).toBe(true);
      expect(isSecretExpression("inputs.apiKey", secrets)).toBe(true);
    });

    it("should not treat non-secret inputs as secrets", () => {
      const secrets = ["password"];
      expect(isSecretExpression("inputs.username", secrets)).toBe(false);
      expect(isSecretExpression("inputs.count", secrets)).toBe(false);
    });

    it("should handle whitespace in expressions", () => {
      expect(isSecretExpression("  env.API_KEY  ", [])).toBe(true);
      expect(isSecretExpression("  inputs.password  ", ["password"])).toBe(true);
    });

    it("should not treat step outputs as secrets", () => {
      expect(isSecretExpression("steps.build.stdout", [])).toBe(false);
      expect(isSecretExpression("steps.api.result", ["password"])).toBe(false);
    });

    it("should handle nested input access", () => {
      const secrets = ["config"];
      expect(isSecretExpression("inputs.config.password", secrets)).toBe(true);
      expect(isSecretExpression("inputs.config.nested.key", secrets)).toBe(true);
    });
  });

  describe("extractSecretExpressions", () => {
    it("should extract env expressions from template", () => {
      const template = "curl -H 'Authorization: Bearer {{env.API_KEY}}' https://api.example.com";
      const secrets = extractSecretExpressions(template, []);
      expect(secrets).toEqual(["env.API_KEY"]);
    });

    it("should extract secret input expressions", () => {
      const template = "echo {{inputs.password}} | base64";
      const secrets = extractSecretExpressions(template, ["password"]);
      expect(secrets).toEqual(["inputs.password"]);
    });

    it("should extract multiple secret expressions", () => {
      const template = "DB_PASS={{env.DB_PASSWORD}} API_KEY={{inputs.apiKey}}";
      const secrets = extractSecretExpressions(template, ["apiKey"]);
      expect(secrets).toEqual(["env.DB_PASSWORD", "inputs.apiKey"]);
    });

    it("should not extract non-secret expressions", () => {
      const template = "Hello {{inputs.name}}, your count is {{inputs.count}}";
      const secrets = extractSecretExpressions(template, ["password"]);
      expect(secrets).toEqual([]);
    });
  });

  describe("containsSecrets", () => {
    it("should return true if template contains secrets", () => {
      expect(containsSecrets("{{env.API_KEY}}", [])).toBe(true);
      expect(containsSecrets("{{inputs.password}}", ["password"])).toBe(true);
    });

    it("should return false if template contains no secrets", () => {
      expect(containsSecrets("{{inputs.name}}", [])).toBe(false);
      expect(containsSecrets("Hello world", ["password"])).toBe(false);
    });
  });

  describe("maskSecretValue", () => {
    it("should completely mask short values", () => {
      expect(maskSecretValue("abc")).toBe(SECRET_MASK);
      expect(maskSecretValue("1234")).toBe(SECRET_MASK);
      expect(maskSecretValue("")).toBe(SECRET_MASK);
    });

    it("should show first char + mask for longer values", () => {
      expect(maskSecretValue("password123")).toBe(`p${SECRET_MASK}`);
      expect(maskSecretValue("super-secret-key")).toBe(`s${SECRET_MASK}`);
    });
  });

  describe("maskInterpolatedString", () => {
    it("should replace secret values with mask", () => {
      const secretValues = new Map([
        ["env.API_KEY", "sk-12345678"],
      ]);
      const result = maskInterpolatedString(
        "curl -H 'Authorization: Bearer sk-12345678'",
        secretValues
      );
      expect(result).toBe("curl -H 'Authorization: Bearer ***'");
    });

    it("should handle multiple secrets", () => {
      const secretValues = new Map([
        ["env.USER", "admin"],
        ["inputs.password", "secret123"],
      ]);
      const result = maskInterpolatedString(
        "login -u admin -p secret123",
        secretValues
      );
      expect(result).toBe("login -u *** -p ***");
    });

    it("should handle overlapping values by replacing longest first", () => {
      const secretValues = new Map([
        ["short", "pass"],
        ["long", "password123"],
      ]);
      // "password123" should be replaced before "pass"
      const result = maskInterpolatedString(
        "The password is password123",
        secretValues
      );
      expect(result).toBe("The ***word is ***");
    });
  });

  describe("encryption", () => {
    const encryptionKey = "test-encryption-key-32-chars!!!";

    describe("encryptForStorage / decryptFromStorage", () => {
      it("should encrypt and decrypt string data", () => {
        const original = "my-secret-password";
        const encrypted = encryptForStorage(original, encryptionKey);
        
        expect(encrypted.encrypted).toBe(true);
        expect(typeof encrypted.data).toBe("string");
        expect(encrypted.data).not.toBe(original);
        
        const decrypted = decryptFromStorage(encrypted, encryptionKey);
        expect(decrypted).toBe(original);
      });

      it("should produce different ciphertext for same plaintext (random IV)", () => {
        const original = "same-secret";
        const encrypted1 = encryptForStorage(original, encryptionKey);
        const encrypted2 = encryptForStorage(original, encryptionKey);
        
        expect(encrypted1.data).not.toBe(encrypted2.data);
        
        // But both should decrypt to same value
        expect(decryptFromStorage(encrypted1, encryptionKey)).toBe(original);
        expect(decryptFromStorage(encrypted2, encryptionKey)).toBe(original);
      });

      it("should fail to decrypt with wrong key", () => {
        const original = "secret-data";
        const encrypted = encryptForStorage(original, encryptionKey);
        
        expect(() => {
          decryptFromStorage(encrypted, "wrong-key-12345678901234567890");
        }).toThrow();
      });

      it("should reject encryption keys shorter than 16 characters", () => {
        expect(() => {
          encryptForStorage("test-data", "short");
        }).toThrow(/Encryption key must be at least 16 characters/);

        expect(() => {
          encryptForStorage("test-data", "");
        }).toThrow(/Encryption key must be at least 16 characters/);
      });

      it("should reject decryption keys shorter than 16 characters", () => {
        const encrypted = encryptForStorage("test", encryptionKey);
        
        expect(() => {
          decryptFromStorage(encrypted, "short");
        }).toThrow(/Encryption key must be at least 16 characters/);
      });
    });

    describe("isEncryptedData", () => {
      it("should identify encrypted data structures", () => {
        const encrypted = encryptForStorage("test", encryptionKey);
        expect(isEncryptedData(encrypted)).toBe(true);
      });

      it("should reject non-encrypted data", () => {
        expect(isEncryptedData({ foo: "bar" })).toBe(false);
        expect(isEncryptedData("string")).toBe(false);
        expect(isEncryptedData(123)).toBe(false);
        expect(isEncryptedData(null)).toBe(false);
        expect(isEncryptedData({ encrypted: false, data: "foo" })).toBe(false);
      });
    });

    describe("encryptSecretInputs / decryptSecretInputs", () => {
      it("should only encrypt specified secret keys", () => {
        const inputs = {
          username: "john",
          password: "secret123",
          count: 42,
        };
        
        const encrypted = encryptSecretInputs(inputs, ["password"], encryptionKey);
        
        // username and count should be unchanged
        expect(encrypted.username).toBe("john");
        expect(encrypted.count).toBe(42);
        
        // password should be encrypted
        expect(isEncryptedData(encrypted.password)).toBe(true);
      });

      it("should decrypt encrypted inputs", () => {
        const inputs = {
          username: "john",
          password: "secret123",
        };
        
        const encrypted = encryptSecretInputs(inputs, ["password"], encryptionKey);
        const decrypted = decryptSecretInputs(encrypted, encryptionKey);
        
        expect(decrypted.username).toBe("john");
        expect(decrypted.password).toBe("secret123");
      });

      it("should handle multiple secret keys", () => {
        const inputs = {
          apiKey: "key-123",
          dbPassword: "pass-456",
          host: "localhost",
        };
        
        const encrypted = encryptSecretInputs(
          inputs,
          ["apiKey", "dbPassword"],
          encryptionKey
        );
        
        expect(isEncryptedData(encrypted.apiKey)).toBe(true);
        expect(isEncryptedData(encrypted.dbPassword)).toBe(true);
        expect(encrypted.host).toBe("localhost");
        
        const decrypted = decryptSecretInputs(encrypted, encryptionKey);
        expect(decrypted).toEqual(inputs);
      });

      it("should handle non-string secret values", () => {
        const inputs = {
          config: { password: "secret", host: "localhost" },
        };
        
        const encrypted = encryptSecretInputs(inputs, ["config"], encryptionKey);
        expect(isEncryptedData(encrypted.config)).toBe(true);
        
        const decrypted = decryptSecretInputs(encrypted, encryptionKey);
        expect(decrypted.config).toEqual(inputs.config);
      });

      it("should preserve already decrypted values on re-decrypt", () => {
        const inputs = {
          username: "john",
          password: "secret123",
        };
        
        // Already plain inputs should pass through unchanged
        const decrypted = decryptSecretInputs(inputs, encryptionKey);
        expect(decrypted).toEqual(inputs);
      });
    });
  });
});
