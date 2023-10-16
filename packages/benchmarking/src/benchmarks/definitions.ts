function numberedControledTemplate(thousands: number) {
  return {
    [`write-${thousands}k-iterative`]: {
      control: `client-write-${thousands}k-iterative`,
      experiment: `framework-write-${thousands}k-iterative`
    },
    [`write-${thousands}k-bulk`]: {
      control: `client-write-${thousands}k-bulk`,
      experiment: `framework-write-${thousands}k-bulk`
    },
    [`read-${thousands}k-bulk`]: {
      control: `client-read-${thousands}k-bulk`,
      experiment: `framework-read-${thousands}k-bulk`
    },
    [`read-${thousands}k-iterative`]: {
      control: `client-read-${thousands}k-iterative`,
      experiment: `framework-read-${thousands}k-iterative`
    }
  }
}

const definitions = {
  ...numberedControledTemplate(1),
  ...numberedControledTemplate(100)
};

export function getDefinition(name: keyof typeof definitions) {
  if (!definitions[name]) {
    throw new Error(`No definition for ${name}`);
  }

  return definitions[name];
}
