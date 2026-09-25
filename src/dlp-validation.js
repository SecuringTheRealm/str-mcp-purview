import { CapabilityError } from "./dispatch/errors.js";

const values = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
const fail = (message) => { throw new CapabilityError("VALIDATION_ERROR", message); };
const isAll = (xs) => xs.length === 1 && /^all$/i.test(String(xs[0]?.Name ?? xs[0]?.DisplayName ?? xs[0]));
const users = (xs) => {
  for (const x of xs) if (typeof x !== "string" || !/^[^\s@/]+@[^\s@/]+$/.test(x)) fail("OneDrive user scopes require UPNs, not site URLs or unresolved objects.");
  return xs;
};
const merge = (old, add, remove) => {
  if (add.some((a) => remove.some((r) => a.toLowerCase() === r.toLowerCase()))) fail("Cannot add and remove the same OneDrive user in one request.");
  const excluded = new Set(remove.map((v) => v.toLowerCase()));
  return [...new Map([...old, ...add].filter((v) => !excluded.has(v.toLowerCase())).map((v) => [v.toLowerCase(), v])).values()];
};

export function oneDriveCreate(args) {
  const include = args.onedrive_location;
  const exclude = users(args.location_exceptions?.onedrive ?? []);
  if (include !== undefined && !include.length) {
    if (exclude.length) fail("Cannot exclude OneDrive users while disabling OneDrive.");
    return { OneDriveLocation: null };
  }
  if (include?.length && !isAll(include)) {
    users(include);
    if (exclude.length) fail("OneDrive user inclusions and exclusions cannot be combined.");
    return { OneDriveLocation: ["All"], OneDriveSharedBy: include };
  }
  return include || exclude.length ? { OneDriveLocation: ["All"], ...(exclude.length ? { ExceptIfOneDriveSharedBy: exclude } : {}) } : {};
}

export function needsOneDriveRead(args) {
  return [args.add_locations?.onedrive, args.remove_locations?.onedrive, args.add_location_exceptions?.onedrive, args.remove_location_exceptions?.onedrive].some((v) => v?.length);
}

export function oneDriveUpdate(args, current) {
  if (!needsOneDriveRead(args)) return {};
  if (!current || !Object.hasOwn(current, "OneDriveLocation")) fail("Cannot verify the existing OneDrive policy scope.");
  const add = args.add_locations?.onedrive ?? [], remove = args.remove_locations?.onedrive ?? [];
  const addEx = users(args.add_location_exceptions?.onedrive ?? []), removeEx = users(args.remove_location_exceptions?.onedrive ?? []);
  const existingLocations = values(current.OneDriveLocation);
  if (existingLocations.length && !isAll(existingLocations)) fail("Existing policy uses legacy OneDrive site scopes. Migrate it before editing through this tool.");
  if (isAll(remove)) {
    if (add.length || addEx.length || removeEx.length) fail("Disabling OneDrive cannot be combined with other OneDrive scope edits.");
    return { RemoveOneDriveLocation: ["All"] };
  }
  if (isAll(add) && remove.length) fail("Adding All and removing individual OneDrive users is ambiguous. Use exclusions instead.");
  if (add.length && !isAll(add)) users(add);
  users(remove);
  const oldInclude = users(values(current.OneDriveSharedBy));
  const oldExclude = users(values(current.ExceptIfOneDriveSharedBy));
  if (existingLocations.length && !oldInclude.length && !values(current.OneDriveSharedByMemberOf).length && add.length && !isAll(add)) fail("OneDrive already includes All users; adding named users must not silently narrow the scope.");
  const include = merge(oldInclude, isAll(add) ? [] : add, remove);
  const exclude = merge(oldExclude, addEx, removeEx);
  if (!oldInclude.length && remove.length) fail("Cannot remove named users from an All scope. Use add_location_exceptions.onedrive.");
  if (oldInclude.length && !include.length) fail("Removing the last OneDrive inclusion would broaden the scope. Disable OneDrive explicitly with remove_locations.onedrive:['All'].");
  if ((include.length || values(current.OneDriveSharedByMemberOf).length) && (exclude.length || values(current.ExceptIfOneDriveSharedByMemberOf).length)) fail("OneDrive user/group inclusions and exclusions cannot be combined.");
  const params = {};
  if (add.length) params.AddOneDriveLocation = ["All"];
  if (!existingLocations.length && !add.length && (addEx.length || removeEx.length || remove.length)) fail("OneDrive is disabled. Enable it explicitly before editing its scope.");
  if ((add.length && !isAll(add)) || remove.length) params.OneDriveSharedBy = include;
  if (addEx.length || removeEx.length) params.ExceptIfOneDriveSharedBy = exclude.length ? exclude : null;
  return params;
}

export function assertExchangeOnly(policy) {
  const workloads = values(policy?.Workload).flatMap((v) => String(v).split(/[,;\s]+/)).filter(Boolean);
  if (!workloads.length || workloads.some((v) => v.toLowerCase() !== "exchange")) fail("Sender/recipient exceptions require a verified Exchange-only parent policy.");
  for (const name of ["SharePointLocation", "OneDriveLocation", "TeamsLocation", "EndpointDlpLocation", "OnPremisesScannerDlpLocation", "PowerBIDlpLocation", "ThirdPartyAppDlpLocation"]) {
    if (values(policy[name]).length) fail("Sender/recipient exceptions require an Exchange-only parent policy.");
  }
}

export function assertLocationExceptions(params, current = {}) {
  for (const name of ["SharePointLocation", "TeamsLocation", "EndpointDlpLocation"]) {
    if (!values(params[`${name}Exception`]).length && !values(params[`Add${name}Exception`]).length) continue;
    const added = params[`Add${name}`];
    const removed = values(params[`Remove${name}`]);
    const scope = params[name] ?? (isAll(values(added)) ? added : current[name]);
    if (!isAll(values(scope)) || removed.length) fail(`${name} exceptions require an All scope without simultaneous location removal.`);
  }
}
