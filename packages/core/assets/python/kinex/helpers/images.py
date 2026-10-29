"""Camera images: current frames, pixel arrays for computation and files for finish()."""

from kinex.lib.camera import array, frame, save


async def camera_frame(io, camera, timeout_s=None):
    """The camera's current image and, for an rgbd camera, its depth (else None).

    Both come from one acquisition (equal stamps); reading never advances world time.

    Example: image, depth = await helpers.camera_frame(io, "camera")
    """
    return await frame(io, camera, timeout_s=timeout_s)


def image_array(image):
    """Native-order pixels of a sensor_msgs/Image as numpy: HxWx3 RGB or HxW mono8/16UC1.

    Example: pixels = helpers.image_array((await helpers.camera_frame(io, "camera"))[0])
    """
    return array(image)


def save_image(image):
    """Write a sensor_msgs/Image as a PNG, keeping 16-bit depth, and return its path.

    Example: finish({"stamp": stamp}, file=helpers.save_image(image))
    """
    return save(image)
