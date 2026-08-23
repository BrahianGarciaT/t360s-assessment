import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(() => {
    service = new PasswordService();
  });

  it('hashes a password and confirms a matching compare against the real hash', async () => {
    const hash = await service.hash('correct-horse-battery-staple');

    await expect(
      service.compare('correct-horse-battery-staple', hash),
    ).resolves.toBe(true);
  });

  it('returns false when comparing a wrong password against the hash', async () => {
    const hash = await service.hash('correct-horse-battery-staple');

    await expect(service.compare('wrong-password', hash)).resolves.toBe(false);
  });
});
