#include "turbo-modules/MkvDemuxModule.h"

#include <Kepler/turbomodule/KeplerTurboModuleRegistration.h>

extern "C" {
__attribute__((visibility("default"))) void
    autoLinkKeplerTurboModulesV1() noexcept {
        KEPLER_REGISTER_TURBO_MODULE(MkvDemuxModuleTurboModule, MkvDemuxModule);
 }
}
