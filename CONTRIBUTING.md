# Contributing to o11y-reporter

Thank you for your interest in contributing to o11y-reporter! This document provides guidelines and information for developers who want to contribute to this project.

## Pre-requisites

1. **Node.js**: We use Node.js 20 or higher. If you need to work with multiple versions of Node, consider using [nvm](https://github.com/creationix/nvm).
2. **Yarn**: This repository uses [Yarn](https://yarnpkg.com/) to manage dependencies. Please install Yarn globally using `npm install --global yarn`.
3. **Git**: Make sure you have Git installed and configured.

## Development Setupe

### Initial Setup

1. Clone this repository:

   ```bash
   git clone <repo-url>
   cd o11y-reporter
   ```

2. Install dependencies:

   ```bash
   yarn install
   ```

3. Build the package:
   ```bash
   yarn build
   ```

### Development Workflow

1. We develop using feature branches off `main` and release from the `main` branch.
2. Create a feature branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Make your changes and test them locally.
4. Commit your changes following our commit message format.
5. Push your branch and create a pull request.

## Available Scripts

### Build Commands

- **`yarn build`**: Compiles TypeScript to JavaScript
- **`yarn build:bundle`**: Creates bundled distribution files
- **`yarn package`**: Cleans, builds, and bundles the package
- **`yarn clean`**: Removes generated files and directories

### Testing Commands

- **`yarn test`**: Runs Jest tests
- **`yarn test:watch`**: Runs tests in watch mode

### Code Quality Commands

- **`yarn format`**: Formats code using Prettier
- **`yarn format:ci`**: Checks code formatting (used in CI)
- **`yarn eslint`**: Lints code using ESLint
- **`yarn eslint:ci`**: Lints code with strict settings (used in CI)

## Code Quality Standards

### Commit Message Format

We enforce conventional commit message format using commitlint. Your commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- **feat**: A new feature
- **fix**: A bug fix
- **docs**: Documentation only changes
- **style**: Changes that do not affect the meaning of the code
- **refactor**: A code change that neither fixes a bug nor adds a feature
- **perf**: A code change that improves performance
- **test**: Adding missing tests or correcting existing tests
- **chore**: Changes to the build process or auxiliary tools

Example: `feat: add new telemetry event tracking`

### Pre-commit Hooks

Before commit and push, Husky will run several hooks to ensure:

- Commit message format is correct
- Code lints properly
- Code compiles without errors
- Tests pass

## Testing

### Running Tests

```bash
# Run all tests
yarn test

# Run tests in watch mode
yarn test:watch

# Run tests with specific pattern
yarn test --testPathPattern=src/
```

### Test Structure

Tests are located in the `src/test/` directory and use Jest as the testing framework. Make sure to write tests for any new functionality you add.

## Code Style

### TypeScript

- We use TypeScript for type safety
- Follow the existing code style and patterns
- Ensure all new code is properly typed

### Formatting

- We use Prettier for code formatting
- Run `yarn format` before committing to ensure consistent formatting
- The CI pipeline will check formatting using `yarn format:ci`

### Linting

- We use ESLint for code quality
- Run `yarn eslint` to check for linting issues
- Fix any linting errors before committing
- The CI pipeline will check linting using `yarn eslint:ci`

## Project Structure

```
o11y-reporter/
├── src/                    # Source code
│   ├── index.ts           # Main entry point
│   ├── o11yService.ts     # Core service implementation
│   ├── types/             # TypeScript type definitions
│   ├── utils/             # Utility functions
│   └── test/              # Test files
├── scripts/                # Build scripts
├── dist/                   # Build output (generated)
├── .github/workflows/     # GitHub Actions workflows
│   ├── pr-validation.yml  # PR validation pipeline
│   └── release.yml        # Release pipeline
└── package.json           # Project configuration
```

## Pull Request Process

1. **Create a feature branch** from `main`
2. **Make your changes** following the coding standards
3. **Write tests** for new functionality
4. **Update documentation** if needed
5. **Run local checks**:
   ```bash
   yarn clean
   yarn install
   yarn build
   yarn test
   yarn format
   yarn eslint
   ```
6. **Commit your changes** using conventional commit format
7. **Push your branch** and create a pull request
8. **Ensure CI passes** - all checks must pass before merging

## CI/CD Pipeline

Our CI/CD pipeline uses GitHub Actions workflows that run the following checks:

### Pull Request Validation (`.github/workflows/pr-validation.yml`)

- Code formatting validation
- ESLint checks
- TypeScript compilation
- Test execution
- Build verification
- Package creation

### Release Pipeline (`.github/workflows/release.yml`)

- All validation checks from PR validation
- Semantic release to npm
- Automatic versioning and changelog generation

## Getting Help

If you have questions or need help:

1. Check the existing documentation
2. Review the test files for examples
3. Open an issue for bugs or feature requests
4. Ask questions in pull request discussions

## License

This project is licensed under the Apache License 2.0. See the [LICENSE.txt](LICENSE.txt) file for details.

Thank you for contributing to o11y-reporter!
