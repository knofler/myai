/** Single source of truth for the project's display name + tagline.
 *  init_blueprint.sh rewrites these values from the project name. */
export const branding = {
  name: "__DISPLAY_NAME__",
  description: "Built on the Powerhouse Blueprint.",
} as const;
