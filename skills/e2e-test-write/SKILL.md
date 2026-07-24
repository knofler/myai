---
name: e2e-test-write
description: "Write end-to-end tests for critical user flows using Playwright or Cypress — implement page objects, test happy and error paths, add visual regression. Triggers: E2E test, end-to-end, Playwright, Cypress, browser test, user flow test"
---

# E2E Test Write

Write end-to-end tests that validate critical user flows through the browser.

## Tech Stack

Playwright (preferred) | Cypress | built-in screenshot snapshots

## Playbook

### 1. Identify critical user flows

- Prioritize: sign-up, login, primary CRUD, checkout/payment.
- Keep the E2E suite focused — test only what lower levels cannot.

### 2. Set up Playwright

- Run `npm init playwright@latest`.
- Configure `playwright.config.ts`: base URL, browsers, retries (2 for CI).

### 3. Implement page objects pattern

```typescript
export class LoginPage {
  constructor(private page: Page) {}
  async goto() { await this.page.goto('/login'); }
  async login(email: string, password: string) {
    await this.page.fill('[data-testid="email"]', email);
    await this.page.fill('[data-testid="password"]', password);
    await this.page.click('[data-testid="submit"]');
  }
}
```

### 4. Write happy path tests

```typescript
test('user can log in and see dashboard', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login('user@test.com', 'password123');
  await expect(page).toHaveURL('/dashboard');
});
```

- Use `data-testid` attributes for reliable selectors.

### 5. Write error scenario tests

- Invalid credentials show error message.
- Form validation prevents invalid submissions.

### 6. Add visual regression checks

- Use `await expect(page).toHaveScreenshot()` for key pages.
- Store baselines in version control; review diffs in CI.

### 7. Configure CI

- Use `webServer` in Playwright config to start the app.
- Upload trace artifacts on failure.

### 8. Run and verify

- Run: `npx playwright test`.
- Debug: `npx playwright test --ui` or `--trace on`.
