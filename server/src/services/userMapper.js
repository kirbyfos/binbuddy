export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.user_code,
    name: row.full_name,
    email: row.email,
    phoneNumber: row.phone_number || "",
    address: row.address || "",
    role: row.role,
    ecoPoints: row.eco_points,
    streak: row.streak_days,
    badge: row.level || "Eco Starter",
    barangay: row.barangay || "",
    gender: row.gender || ""
  };
}

const BADGE_LEVELS = [
  { min: 0, label: "Eco Starter" },
  { min: 100, label: "Eco Supporter" },
  { min: 300, label: "BinBuddy" },
  { min: 700, label: "Eco Hero" }
];

export function badgeFromPoints(points) {
  let label = "Eco Starter";
  for (const level of BADGE_LEVELS) {
    if (points >= level.min) label = level.label;
  }
  return label;
}
