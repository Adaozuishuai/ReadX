// Vendored from HenryXiaoYang/realtime-tex-vsc-plugin, a5dc1d9 (MIT). See LICENSE.
export function fontKey(desc) {
    if (desc.filename)
        return `file:${desc.filename}#${desc.subfont ?? 0}`;
    return `tfm:${desc.name ?? desc.id}`;
}
