//! Three-word slug generator for `<slug>.<domain>` URLs, unique per account.
//! Callers retry on a uniqueness violation; generation is not collision-free
//! by design.
//! TODO(reconcile): the wordlist + generator belong in `ori-proto`.

const WORDS: &[&str] = &[
    "amber", "birch", "coral", "delta", "ember", "frost", "grape", "honey", "iris", "jade",
    "kite", "lunar", "moss", "north", "oak", "pearl", "quartz", "river", "snow", "tide",
    "umbra", "violet", "willow", "xenon", "yarrow", "zephyr", "acorn", "bison", "cedar",
    "dune", "elm", "falcon", "gale", "heron", "ivy", "juniper", "koi", "lark", "maple",
    "night", "onyx", "pine", "quail", "raven", "sage", "tiger", "uplands", "vale", "wolf",
    "axis", "bay", "cove", "duck", "eagle", "fern", "glade", "harbor", "island", "jackal",
    "kelp", "lagoon", "meadow", "nettle", "otter", "palm", "quarry", "reed", "sand",
    "thistle", "urn", "vapor", "wren", "yew", "zebra", "bramble", "cinder", "drift",
    "echo", "fjord", "grove", "heath", "inlet", "jasmine", "kestrel", "linden", "moose",
    "nimbus", "orchid", "pebble", "quill", "ridge", "shale", "tor", "umber", "veil",
    "wharf", "yonder", "azure", "brine", "canyon", "delta", "estuary", "foxtail", "glacier",
    "hollow", "indigo", "jet", "kelvin", "lynx", "marrow", "nook", "opal", "primrose",
    "quince", "rook", "sparrow", "tundra", "under", "vixen", "wisp", "yolk", "basalt",
    "cairn", "delphinium", "emerald", "fir", "gull", "hawthorn", "ink", "juniper", "kiwi",
    "lilac", "marigold", "neon", "olive", "pampas", "quetzal", "rhododendron", "saffron",
    "tamarind", "ulmus", "verdigris", "wake", "xenia", "yuzu", "zinnia", "adobe", "burrow",
    "copse", "dandelion", "eider", "flume", "granite", "heather", "iron", "jujube", "kite",
    "lichen", "magnolia", "nugget", "ochre", "plover", "quince", "rutile", "shard", "topaz",
    "umber", "vault", "wattle", "xylem", "yarrow", "zinc", "alder", "beacon", "cricket",
    "dusk", "eel", "foxglove", "gnat", "hatch", "iridescent", "jowl", "kettle", "latch",
    "mire", "nickel", "oyster", "plum", "quagmire", "rattan", "speck", "teak", "usher",
    "vetch", "waxwing", "xanthic", "yarn", "zircon", "avenue", "brook", "cliff", "dale",
    "estuary", "field", "gully", "hollow", "isle", "jungle", "knot", "lea", "moor", "nest",
    "oasis", "path", "quay", "ridge", "strand", "thicket", "underwood", "verge", "wood",
    "yak", "zest", "amber", "birch", "coral", "delta", "ember", "frost", "grape", "honey",
];

/// Random three-word slug like `velvet-quartz-north`. The same word may appear
/// twice; uniqueness comes from the DB constraint, not from here.
pub fn slug() -> String {
    let mut buf = [0u8; 3];
    getrandom::fill(&mut buf).expect("CSPRNG failure");
    let pick = |b: u8| WORDS[b as usize % WORDS.len()];
    format!("{}-{}-{}", pick(buf[0]), pick(buf[1]), pick(buf[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_and_variety() {
        let a = slug();
        let b = slug();
        assert_eq!(a.split('-').count(), 3);
        assert_ne!(a, b);
    }
}