module.exports = {
    dependency: {
        platforms: {
            kepler: {
                "autolink": {
                    "MkvDemuxModule": {
                        "libraryName": "libMkvDemuxModule.so",
                        "linkDynamic": true,
                        "provider": "application",
                        "components": [],
                        "turbomodules": [
                            "MkvDemuxModule"
                        ]
                    }
                }
            },
        },
    },
};