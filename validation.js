const VALID_FREQUENCIES = [
  'weekly', 'monthly', 'quarterly', 'annual'
];

const VALID_STATUSES = [
  'active', 'paused', 'canceled'
];

// Validates subscription details submitted by the client.
function validateSubscriptionPayload(body) {
  const errors = [];

  // Ensure the request body is a valid JSON object.
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body)
  ) {
    return {
      isValid: false,
      errors: ['Request body must be a JSON object.'],
      cleaned: null
    };
  }

  const name = typeof body.name === 'string'
    ? body.name.trim()
    : '';

  const categoryId = body.category_id;
  const amountCents = body.amount_cents;
  const frequency = body.frequency;
  const status = body.status === undefined
    ? 'active'
    : body.status;

  // Validate subscription name.
  if (!name) {
    errors.push(
      'Subscription name is required and cannot be empty.'
    );
  } else if (name.length > 100) {
    errors.push(
      'Subscription name must be 100 characters or fewer.'
    );
  }

  // Validate category ID.
  if (
    typeof categoryId !== 'number' ||
    !Number.isInteger(categoryId) ||
    categoryId <= 0
  ) {
    errors.push('A valid category_id is required.');
  }

  // Validate subscription cost.
  if (
    typeof amountCents !== 'number' ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0
  ) {
    errors.push(
      'Cost must be a positive integer in cents (greater than $0.00).'
    );
  } else if (amountCents > 100000000) {
    errors.push('Cost cannot exceed $1,000,000.00.');
  }

  // Validate billing frequency.
  if (!VALID_FREQUENCIES.includes(frequency)) {
    errors.push(
      `Frequency must be one of: ${VALID_FREQUENCIES.join(', ')}.`
    );
  }

  // Validate subscription status.
  if (!VALID_STATUSES.includes(status)) {
    errors.push(
      `Status must be one of: ${VALID_STATUSES.join(', ')}.`
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    cleaned: {
      name,
      categoryId,
      amountCents,
      frequency,
      status
    }
  };
}

// Export validation function and constants.
module.exports = {
  validateSubscriptionPayload,
  VALID_FREQUENCIES,
  VALID_STATUSES
};