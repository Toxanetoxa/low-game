import antfu from '@antfu/eslint-config';
import prettier from 'eslint-config-prettier';

export default antfu(
  {
    isInEditor: false,
    stylistic: false,
    rules: {
      'ts/consistent-type-definitions': 'off',
      'ts/no-use-before-define': ['error', { functions: false, variables: false }],
    },
  },
  prettier,
);
